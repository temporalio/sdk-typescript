import test from 'ava';
import { Manifest, isEnvValueReference, type Environment, type SandboxSessionState } from '@openai/agents-core/sandbox';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import type { WorkerOptions } from '@temporalio/worker';
import { workerEnvValue } from '../common/worker-env-vars';
import {
  SANDBOX_CLIENT_CREATE_SUFFIX,
  SANDBOX_CLIENT_RESUME_SUFFIX,
  SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX,
  SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX,
  SANDBOX_SESSION_EXEC_SUFFIX,
  decodeManifest,
  encodeManifest,
  type SandboxSessionResult,
} from '../common/sandbox-activity-types';
import { OpenAIAgentsPlugin } from '../worker/plugin';
import { SandboxClientProvider } from '../worker/sandbox-provider';
import { FakeModelProvider } from './stubs/openai-agents';
import { FakeSandboxClient } from './stubs/sandbox-fakes';

const SECRET_VAR = 'OPENAI_AGENTS_TEST_MANIFEST_SECRET';
const SECOND_SECRET_VAR = 'OPENAI_AGENTS_TEST_SECOND_MANIFEST_SECRET';
const SECRET = 'sk-manifest-environment-sentinel';
const SECOND_SECRET = 'sk-second-manifest-environment-sentinel';
const PLAIN = 'plainvalue';

class ResolvingSandboxClient extends FakeSandboxClient {
  // Dropping the custom (de)serializers routes providerState through the
  // provider's own fallback, the path this plugin owns.
  serializeSessionState = undefined as any;
  deserializeSessionState = undefined as any;
}

function manifestWith(secret: string | ReturnType<typeof workerEnvValue>): Manifest {
  return new Manifest({ environment: { API_KEY: secret, PLAIN } });
}

function payloadText(input: unknown): string {
  return Buffer.from(defaultPayloadConverter.toPayload(input)!.data!).toString('utf8');
}

function roundTrip<T>(input: T): T {
  return defaultPayloadConverter.fromPayload<T>(defaultPayloadConverter.toPayload(input)!);
}

function activityMap(
  client: FakeSandboxClient,
  resolvableWorkerEnvVars: readonly string[] = [SECRET_VAR]
): Record<string, (...args: any[]) => Promise<any>> {
  const provider = new SandboxClientProvider('fake', client);
  provider._setResolvableWorkerEnvVars(resolvableWorkerEnvVars);
  return provider._getActivities();
}

/** A manifest value as the Worker holds it: decoded from the Activity argument. */
function workerValue(name: string, resolvableWorkerEnvVars: readonly string[] = [SECRET_VAR]): Environment {
  return decodeManifest(roundTrip(encodeManifest(manifestWith(workerEnvValue(name)))), resolvableWorkerEnvVars)
    .environment.API_KEY!;
}

async function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[SECRET_VAR];
  const apply = (v: string | undefined) => {
    if (v === undefined) delete process.env[SECRET_VAR];
    else process.env[SECRET_VAR] = v;
  };
  apply(value);
  try {
    await fn();
  } finally {
    apply(previous);
  }
}

async function withEnvValue<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  let result: T;
  await withEnv(value, async () => {
    result = await fn();
  });
  return result!;
}

test('encodeManifest emits only the variable name for a reference, and a literal for everything else', (t) => {
  const encoded = encodeManifest(manifestWith(workerEnvValue(SECRET_VAR)));

  t.deepEqual(encoded.environment.API_KEY, { type: 'temporal.worker-env-value', name: SECRET_VAR });
  t.deepEqual(encoded.environment.PLAIN, { value: PLAIN });
  t.false(payloadText(encoded).includes(SECRET));
});

test.serial('encode -> decode reconstructs a reference that resolves to the real value', async (t) => {
  const decoded = decodeManifest(roundTrip(encodeManifest(manifestWith(workerEnvValue(SECRET_VAR)))), [SECRET_VAR]);
  const reference = decoded.environment.API_KEY!;

  t.true(isEnvValueReference(reference));
  // A reference is not resolver-backed, so it does not trip the resolver guard,
  // and it needs no `ephemeral` flag to stay out of persisted state.
  t.is(reference.resolver, undefined);
  t.false(reference.ephemeral);
  t.notThrows(() => encodeManifest(decoded));

  await withEnv(SECRET, async () => {
    t.deepEqual(await decoded.resolveEnvironment(), { API_KEY: SECRET, PLAIN });
  });
});

test.serial('an allowlisted variable that is unset or empty resolves to the empty string', async (t) => {
  const value = workerValue(SECRET_VAR);

  for (const [state, env] of [
    ['unset', undefined],
    ['empty', ''],
  ] as Array<[string, string | undefined]>) {
    await withEnv(env, async () => {
      t.is(await value.resolve(), '', state);
    });
  }
});

test.serial(
  'a manifest secret reaches every sandbox Activity payload as a literal, but never as a reference',
  async (t) => {
    for (const [label, secret, mustLeak] of [
      ['literal', SECRET, true],
      ['workerEnvValue', workerEnvValue(SECRET_VAR), false],
    ] as Array<[string, string | ReturnType<typeof workerEnvValue>, boolean]>) {
      const acts = activityMap(new ResolvingSandboxClient());
      const createInput = { manifest: encodeManifest(manifestWith(secret)) };

      await withEnv(SECRET, async () => {
        t.is(payloadText(createInput).includes(SECRET), mustLeak, `${label}: create argument`);

        const created: SandboxSessionResult = await acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
          roundTrip(createInput)
        );

        // The handle every later Activity argument embeds.
        t.is(payloadText(created).includes(SECRET), mustLeak, `${label}: create result`);
        t.is(payloadText({ state: created.state }).includes(SECRET), mustLeak, `${label}: session Activity argument`);

        // Re-encoded after the SDK merges a manifest delta.
        const merged = await acts[`fake${SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX}`]!({
          state: created.state,
          manifest: encodeManifest(new Manifest({ environment: { EXTRA: 'extra' } })),
        });
        t.is(payloadText(merged).includes(SECRET), mustLeak, `${label}: applyManifest result`);

        // A plain session Activity result carries no manifest either way.
        const exec = await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state: created.state, args: { cmd: 'x' } });
        t.false(payloadText(exec).includes(SECRET), `${label}: exec result`);
      });
    }
  }
);

test.serial('the Worker resolves a manifest reference into the environment the backend receives', async (t) => {
  const client = new ResolvingSandboxClient();
  const acts = activityMap(client);

  await withEnv(SECRET, async () => {
    const created: SandboxSessionResult = await acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
      roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) })
    );

    t.deepEqual(client.session.state.environment, { API_KEY: SECRET, PLAIN });
    t.deepEqual(created.state.providerState.environment, { PLAIN });
  });
});

test.serial(
  'a name outside the allowlist fails the create Activity rather than reaching the backend empty',
  async (t) => {
    const acts = activityMap(new ResolvingSandboxClient(), ['SOME_OTHER_VAR']);
    const input = roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) });

    await withEnv(SECRET, async () => {
      const err = await t.throwsAsync(acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(input), {
        instanceOf: ApplicationFailure,
      });
      t.is(err?.type, 'WorkerEnvValueError');
      t.true(err?.nonRetryable);
      t.true(err!.message.includes(SECRET_VAR));
      t.false(err!.message.includes(SECRET));
    });
  }
);

test.serial("the entry '*' makes every variable name readable", async (t) => {
  await withEnv(SECRET, async () => {
    t.is(await workerValue(SECRET_VAR, ['SOME_OTHER_VAR', '*']).resolve(), SECRET);
  });
});

test.serial("the entry '*' still reads nothing for a name that only Object.prototype carries", async (t) => {
  const client = new ResolvingSandboxClient();
  const acts = activityMap(client, ['*']);

  await acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
    roundTrip({ manifest: encodeManifest(new Manifest({ environment: { API_KEY: workerEnvValue('constructor') } })) })
  );

  t.is(client.session.state.environment!.API_KEY, '');
});

test.serial('a persisted reference whose name is missing or not a string is rejected on decode', (t) => {
  for (const name of [undefined, 42]) {
    const encoded = encodeManifest(manifestWith(workerEnvValue(SECRET_VAR)));
    const reference = encoded.environment.API_KEY as Record<string, unknown>;
    if (name === undefined) delete reference.name;
    else reference.name = name;

    const err = t.throws(() => decodeManifest(roundTrip(encoded)), { instanceOf: ApplicationFailure }, String(name));
    t.is(err?.type, 'WorkerEnvValueError', String(name));
    t.true(err?.nonRetryable, String(name));
  }
});

function configuredSandboxActivities(resolvableWorkerEnvVars?: readonly string[]) {
  const client = new ResolvingSandboxClient();
  const plugin = new OpenAIAgentsPlugin({
    modelProvider: new FakeModelProvider([]),
    sandboxClientProviders: [new SandboxClientProvider('fake', client)],
    ...(resolvableWorkerEnvVars && { resolvableWorkerEnvVars }),
  });
  const { activities } = plugin.configureWorker({ taskQueue: 'test' } as WorkerOptions);
  return { client, create: (activities as Record<string, any>)[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]! };
}

test.serial("a plugin never configured as a Worker leaves an earlier Worker's allowlist alone", async (t) => {
  const input = roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) });

  await withEnv(SECRET, async () => {
    const worker = configuredSandboxActivities([SECRET_VAR]);

    // The same class is the Client plugin, so a process that starts Workflows builds one with
    // no Worker environment role of its own.
    new OpenAIAgentsPlugin({ modelProvider: new FakeModelProvider([]) });

    await worker.create(input);
    t.deepEqual(worker.client.session.state.environment, { API_KEY: SECRET, PLAIN });
  });
});

test.serial('plugins bind Worker environment authorization to their own sandbox providers', async (t) => {
  const first = configuredSandboxActivities([SECRET_VAR]);
  const second = configuredSandboxActivities([SECOND_SECRET_VAR]);
  const previousSecond = process.env[SECOND_SECRET_VAR];
  process.env[SECOND_SECRET_VAR] = SECOND_SECRET;

  try {
    await withEnv(SECRET, async () => {
      await first.create(roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) }));
      await second.create(roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECOND_SECRET_VAR))) }));

      t.deepEqual(first.client.session.state.environment, { API_KEY: SECRET, PLAIN });
      t.deepEqual(second.client.session.state.environment, { API_KEY: SECOND_SECRET, PLAIN });

      const firstErr = await t.throwsAsync(
        first.create(roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECOND_SECRET_VAR))) })),
        { instanceOf: ApplicationFailure }
      );
      const secondErr = await t.throwsAsync(
        second.create(roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) })),
        { instanceOf: ApplicationFailure }
      );
      t.is(firstErr?.type, 'WorkerEnvValueError');
      t.is(secondErr?.type, 'WorkerEnvValueError');
    });
  } finally {
    if (previousSecond === undefined) delete process.env[SECOND_SECRET_VAR];
    else process.env[SECOND_SECRET_VAR] = previousSecond;
  }
});

test.serial('a Worker that allowlists nothing reads nothing', async (t) => {
  const input = roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) });

  await withEnv(SECRET, async () => {
    for (const [label, names] of [
      ['empty', []],
      ['omitted', undefined],
    ] as Array<[string, readonly string[] | undefined]>) {
      const err = await t.throwsAsync(configuredSandboxActivities(names).create(input), {
        instanceOf: ApplicationFailure,
      });
      t.is(err?.type, 'WorkerEnvValueError', label);
      t.true(err!.message.includes(SECRET_VAR), label);
      t.false(err!.message.includes(SECRET), label);
    }
  });
});

/** Mirrors `deserializeLocalSandboxSessionStateValues`, which resolves inside deserializeSessionState. */
class DeserializingSandboxClient extends FakeSandboxClient {
  override async deserializeSessionState(state: Record<string, unknown>): Promise<SandboxSessionState> {
    const deserialized = await super.deserializeSessionState(state);
    deserialized.environment = await deserialized.manifest.resolveEnvironment();
    return deserialized;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class GatedDeserializingSandboxClient extends FakeSandboxClient {
  ownValue?: string;
  otherError?: unknown;

  constructor(
    private readonly entered: () => void,
    private readonly proceed: Promise<void>
  ) {
    super();
  }

  override async deserializeSessionState(state: Record<string, unknown>): Promise<SandboxSessionState> {
    this.entered();
    await this.proceed;
    const deserialized = await super.deserializeSessionState(state);
    this.ownValue = await deserialized.manifest.environment.OWN!.resolve();
    try {
      await deserialized.manifest.environment.OTHER!.resolve();
    } catch (err) {
      this.otherError = err;
    }
    return deserialized;
  }
}

test.serial('overlapping custom deserializers retain their provider Worker environment allowlists', async (t) => {
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstProceed = deferred();
  const secondProceed = deferred();
  const firstClient = new GatedDeserializingSandboxClient(firstEntered.resolve, firstProceed.promise);
  const secondClient = new GatedDeserializingSandboxClient(secondEntered.resolve, secondProceed.promise);
  const firstActs = activityMap(firstClient, [SECRET_VAR]);
  const secondActs = activityMap(secondClient, [SECOND_SECRET_VAR]);
  const previousSecret = process.env[SECRET_VAR];
  const previousSecondSecret = process.env[SECOND_SECRET_VAR];
  process.env[SECRET_VAR] = SECRET;
  process.env[SECOND_SECRET_VAR] = SECOND_SECRET;

  const input = (sessionId: string, own: string, other: string) =>
    roundTrip({
      state: {
        sessionId,
        manifest: encodeManifest(
          new Manifest({ environment: { OWN: workerEnvValue(own), OTHER: workerEnvValue(other) } })
        ),
        providerState: {},
      },
    });

  try {
    const firstResume = firstActs[`fake${SANDBOX_CLIENT_RESUME_SUFFIX}`]!(
      input('first-session', SECRET_VAR, SECOND_SECRET_VAR)
    );
    await firstEntered.promise;
    const secondResume = secondActs[`fake${SANDBOX_CLIENT_RESUME_SUFFIX}`]!(
      input('second-session', SECOND_SECRET_VAR, SECRET_VAR)
    );
    await secondEntered.promise;
    secondProceed.resolve();
    await secondResume;
    firstProceed.resolve();
    await firstResume;

    t.is(firstClient.ownValue, SECRET);
    t.is(secondClient.ownValue, SECOND_SECRET);
    t.is((firstClient.otherError as ApplicationFailure | undefined)?.type, 'WorkerEnvValueError');
    t.is((secondClient.otherError as ApplicationFailure | undefined)?.type, 'WorkerEnvValueError');
  } finally {
    if (previousSecret === undefined) delete process.env[SECRET_VAR];
    else process.env[SECRET_VAR] = previousSecret;
    if (previousSecondSecret === undefined) delete process.env[SECOND_SECRET_VAR];
    else process.env[SECOND_SECRET_VAR] = previousSecondSecret;
  }
});

test.serial('a backend that deserializes session state itself resolves against the allowlist too', async (t) => {
  const client = new DeserializingSandboxClient();
  const acts = activityMap(client);
  const input = roundTrip({
    state: {
      sessionId: 'session-1',
      manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))),
      providerState: {},
    },
  });

  await withEnv(SECRET, async () => {
    await acts[`fake${SANDBOX_CLIENT_RESUME_SUFFIX}`]!(input);
  });

  t.deepEqual(client.session.state.environment, { API_KEY: SECRET, PLAIN });
});

test.serial('a resumed session restores reference and Worker-injected values through the fallback', async (t) => {
  const client = new ResolvingSandboxClient();
  const acts = activityMap(client);
  const created: SandboxSessionResult = await withEnvValue(SECRET, async () =>
    acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
      roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) })
    )
  );
  // A key the backend injected, which is not in the manifest and cannot be re-derived.
  client.session.state.environment = { ...client.session.state.environment, INJECTED: 'from-backend' };
  const handle = roundTrip(
    await acts[`fake${SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX}`]!({ state: created.state })
  );

  t.false(payloadText(handle).includes(SECRET), 'the persisted handle still carries no secret');

  // A fresh Worker: empty session cache, so the next operation self-heals via resume().
  const fresh = new ResolvingSandboxClient();
  const freshActs = activityMap(fresh);
  await withEnvValue(SECRET, async () =>
    freshActs[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({
      state: { ...created.state, providerState: (handle as { providerState: Record<string, unknown> }).providerState },
      args: { cmd: 'x' },
    })
  );

  t.deepEqual(fresh.session.state.environment, { INJECTED: 'from-backend', PLAIN, API_KEY: SECRET });
});

test.serial(
  'a persisted environment whose values are not strings is discarded rather than spread into the session',
  async (t) => {
    const client = new ResolvingSandboxClient();
    const acts = activityMap(client);
    const created: SandboxSessionResult = await withEnvValue(SECRET, async () =>
      acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
        roundTrip({ manifest: encodeManifest(manifestWith(workerEnvValue(SECRET_VAR))) })
      )
    );

    const fresh = new ResolvingSandboxClient();
    await withEnvValue(SECRET, async () =>
      activityMap(fresh)[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({
        state: { ...created.state, providerState: { environment: { NESTED: { value: 'x' } } } },
        args: { cmd: 'x' },
      })
    );

    t.deepEqual(fresh.session.state.environment, { PLAIN, API_KEY: SECRET });
  }
);
