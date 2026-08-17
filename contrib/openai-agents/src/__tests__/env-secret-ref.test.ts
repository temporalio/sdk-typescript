import test from 'ava';
import {
  EnvValueReference,
  Manifest,
  isEnvValueReference,
  type SandboxClientCreateArgs,
  type SandboxSession,
} from '@openai/agents-core/sandbox';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import { envSecretRef } from '../common/env-secret-ref';
import {
  SANDBOX_CLIENT_CREATE_SUFFIX,
  SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX,
  SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX,
  SANDBOX_SESSION_EXEC_SUFFIX,
  decodeManifest,
  encodeManifest,
  type SandboxSessionResult,
} from '../common/sandbox-activity-types';
import { SandboxClientProvider } from '../worker/sandbox-provider';
import { FakeSandboxClient } from './stubs/sandbox-fakes';

const SECRET_VAR = 'OPENAI_AGENTS_TEST_MANIFEST_SECRET';
const SECRET = 'sk-manifest-environment-sentinel';
const PLAIN = 'plainvalue';

/** Mirrors the real backends, which resolve the manifest environment on create. */
class ResolvingSandboxClient extends FakeSandboxClient {
  // Dropping the custom (de)serializers routes providerState through the
  // provider's own fallback, the path this plugin owns.
  serializeSessionState = undefined as any;
  deserializeSessionState = undefined as any;

  async create(args?: SandboxClientCreateArgs | Manifest): Promise<SandboxSession> {
    const session = await super.create(args);
    session.state.environment = await session.state.manifest.resolveEnvironment();
    return session;
  }
}

function manifestWith(secret: string | ReturnType<typeof envSecretRef>): Manifest {
  return new Manifest({ environment: { API_KEY: secret, PLAIN } });
}

function payloadText(input: unknown): string {
  return Buffer.from(defaultPayloadConverter.toPayload(input)!.data!).toString('utf8');
}

function roundTrip<T>(input: T): T {
  return defaultPayloadConverter.fromPayload<T>(defaultPayloadConverter.toPayload(input)!);
}

function activityMap(client: FakeSandboxClient): Record<string, (...args: any[]) => Promise<any>> {
  return new SandboxClientProvider('fake', client)._getActivities();
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

test('envSecretRef rejects a name that is empty or contains whitespace', (t) => {
  for (const name of ['', ' ', 'HAS SPACE', 'TRAILING\t', 'NEW\nLINE']) {
    const err = t.throws(() => envSecretRef(name), { instanceOf: ApplicationFailure }, JSON.stringify(name));
    t.is(err?.type, 'SecretReferenceNameError', JSON.stringify(name));
    t.true(err?.nonRetryable, JSON.stringify(name));
  }
  t.notThrows(() => envSecretRef('OK_NAME'));
});

test('a variable name inherited from Object.prototype resolves as unset, not as the inherited member', async (t) => {
  const err = await t.throwsAsync(envSecretRef('toString').resolve(), { instanceOf: ApplicationFailure });

  t.is(err?.type, 'SecretReferenceError');
  t.true(err!.message.includes('not set'));
});

test('encodeManifest emits only the variable name for a reference, and a literal for everything else', (t) => {
  const encoded = encodeManifest(manifestWith(envSecretRef(SECRET_VAR)));

  t.deepEqual(encoded.environment.API_KEY, { type: 'temporal.worker-env-secret', name: SECRET_VAR });
  t.deepEqual(encoded.environment.PLAIN, { value: PLAIN });
  t.false(payloadText(encoded).includes(SECRET));
});

test.serial('encode -> decode reconstructs a reference that resolves to the real value', async (t) => {
  const encoded = roundTrip(encodeManifest(manifestWith(envSecretRef(SECRET_VAR))));
  const decoded = decodeManifest(encoded);
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

test.serial(
  'an unset or empty Worker environment variable fails resolution non-retryably, naming the variable',
  async (t) => {
    const reference = decodeManifest(roundTrip(encodeManifest(manifestWith(envSecretRef(SECRET_VAR))))).environment
      .API_KEY!;

    for (const [state, value] of [
      ['unset', undefined],
      ['empty', ''],
    ] as Array<[string, string | undefined]>) {
      await withEnv(value, async () => {
        const err = await t.throwsAsync(reference.resolve(), { instanceOf: ApplicationFailure }, state);
        t.is(err?.type, 'SecretReferenceError', state);
        t.true(err?.nonRetryable, state);
        t.true(err!.message.includes(SECRET_VAR), state);
        t.true(err!.message.includes(value === undefined ? 'not set' : 'empty'), state);
        t.false(err!.message.includes(SECRET), state);
      });
    }
  }
);

test('encodeManifest still rejects a resolver-backed value, and points at envSecretRef', (t) => {
  const manifest = new Manifest({ environment: { API_KEY: { value: '', resolve: () => SECRET } } });

  const err = t.throws(() => encodeManifest(manifest), { instanceOf: ApplicationFailure });
  t.is(err?.type, 'SandboxConfigurationError');
  t.true(err?.nonRetryable);
  t.regex(err!.message, /API_KEY/);
  t.regex(err!.message, /envSecretRef/);
});

test.serial(
  'a manifest secret reaches every sandbox Activity payload as a literal, but never as a reference',
  async (t) => {
    for (const [label, secret, mustLeak] of [
      ['literal', SECRET, true],
      ['envSecretRef', envSecretRef(SECRET_VAR), false],
    ] as Array<[string, string | ReturnType<typeof envSecretRef>, boolean]>) {
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
      roundTrip({ manifest: encodeManifest(manifestWith(envSecretRef(SECRET_VAR))) })
    );

    t.deepEqual(client.session.state.environment, { API_KEY: SECRET, PLAIN });
    t.deepEqual(created.state.providerState.environment, { PLAIN });
  });
});

test.serial('an unresolvable reference fails the create Activity rather than reaching the backend empty', async (t) => {
  const client = new ResolvingSandboxClient();
  const acts = activityMap(client);
  const input = roundTrip({ manifest: encodeManifest(manifestWith(envSecretRef(SECRET_VAR))) });

  await withEnv(undefined, async () => {
    const err = await t.throwsAsync(acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(input), {
      instanceOf: ApplicationFailure,
    });
    t.is(err?.type, 'SecretReferenceError');
    t.true(err?.nonRetryable);
    t.true(err!.message.includes(SECRET_VAR));
  });
});

test.serial(
  'resolving a reference without a process global fails cleanly instead of throwing ReferenceError',
  async (t) => {
    const reference = decodeManifest(roundTrip(encodeManifest(manifestWith(envSecretRef(SECRET_VAR))))).environment
      .API_KEY!;
    const globals = globalThis as { process?: typeof process };
    const saved = globals.process;

    await withEnv(SECRET, async () => {
      delete globals.process;
      let err: ApplicationFailure | undefined;
      try {
        err = await t.throwsAsync(reference.resolve(), { instanceOf: ApplicationFailure });
      } finally {
        globals.process = saved;
      }
      t.is(err?.type, 'SecretReferenceError');
      t.true(err?.nonRetryable);
      t.true(err!.message.includes(SECRET_VAR));
      t.false(err!.message.includes(SECRET));
    });
  }
);

test.serial('a resumed session restores reference and Worker-injected values through the fallback', async (t) => {
  const client = new ResolvingSandboxClient();
  const acts = activityMap(client);
  const created: SandboxSessionResult = await withEnvValue(SECRET, async () =>
    acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
      roundTrip({ manifest: encodeManifest(manifestWith(envSecretRef(SECRET_VAR))) })
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

/** A user-defined reference registered on the Worker only, as Workflow code sees it. */
class WorkerOnlyReference extends EnvValueReference {
  static readonly type = 'temporal.test-worker-only';

  constructor(readonly name: string) {
    super();
  }

  serialize(): Record<string, unknown> {
    return { name: this.name };
  }

  async resolve(): Promise<string> {
    return SECRET;
  }
}

test('encodeManifest rejects a reference class this bundle never registered rather than throwing a raw TypeError', (t) => {
  const manifest = new Manifest({ environment: { API_KEY: new WorkerOnlyReference(SECRET_VAR) } });

  const err = t.throws(() => encodeManifest(manifest), { instanceOf: ApplicationFailure });
  t.is(err?.type, 'SandboxConfigurationError');
  t.true(err?.nonRetryable);
  t.regex(err!.message, /API_KEY/);
});

test('decodeManifest rejects an unregistered reference type rather than throwing a raw TypeError', (t) => {
  const encoded = encodeManifest(manifestWith(envSecretRef(SECRET_VAR)));
  encoded.environment.API_KEY = { type: 'temporal.not-registered', name: SECRET_VAR };

  const err = t.throws(() => decodeManifest(encoded), { instanceOf: ApplicationFailure });
  t.is(err?.type, 'SandboxSessionStateInvalid');
  t.true(err?.nonRetryable);
  t.regex(err!.message, /temporal\.not-registered/);
});

test.serial(
  'a persisted environment whose values are not strings is discarded rather than spread into the session',
  async (t) => {
    const client = new ResolvingSandboxClient();
    const acts = activityMap(client);
    const created: SandboxSessionResult = await withEnvValue(SECRET, async () =>
      acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!(
        roundTrip({ manifest: encodeManifest(manifestWith(envSecretRef(SECRET_VAR))) })
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
