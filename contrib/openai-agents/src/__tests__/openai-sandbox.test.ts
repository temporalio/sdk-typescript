import test from 'ava';
import { Agent, handoff } from '@openai/agents-core';
import {
  Manifest,
  SandboxAgent,
  SandboxError,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSessionState,
} from '@openai/agents-core/sandbox';
import { deserializeManifest } from '@openai/agents-core/sandbox/internal';
import { ApplicationFailure } from '@temporalio/common';
import {
  SANDBOX_ACTIVITY_SUFFIXES,
  SANDBOX_CLIENT_CREATE_SUFFIX,
  SANDBOX_CLIENT_DELETE_SUFFIX,
  SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX,
  SANDBOX_EDITOR_UPDATE_FILE_SUFFIX,
  SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX,
  SANDBOX_SESSION_DELETE_SUFFIX,
  SANDBOX_SESSION_EXEC_COMMAND_SUFFIX,
  SANDBOX_SESSION_EXEC_SUFFIX,
  SANDBOX_SESSION_HYDRATE_WORKSPACE_SUFFIX,
  SANDBOX_SESSION_LIST_DIR_SUFFIX,
  SANDBOX_SESSION_MATERIALIZE_ENTRY_SUFFIX,
  SANDBOX_SESSION_PATH_EXISTS_SUFFIX,
  SANDBOX_SESSION_PERSIST_WORKSPACE_SUFFIX,
  SANDBOX_SESSION_READ_FILE_SUFFIX,
  SANDBOX_SESSION_RUNNING_SUFFIX,
  SANDBOX_SESSION_SHUTDOWN_SUFFIX,
  SANDBOX_SESSION_START_SUFFIX,
  SANDBOX_SESSION_STOP_SUFFIX,
  SANDBOX_SESSION_VIEW_IMAGE_SUFFIX,
  SANDBOX_SESSION_WRITE_STDIN_SUFFIX,
  base64ToBytes,
  bytesToBase64,
  decodeManifest,
  decodeToolOutputImage,
  encodeManifest,
  reviveWorkflowSessionState,
  serializeSessionEnvelope,
  type SandboxSessionResult,
  type SerializedSandboxSessionState,
  type SerializedToolOutputImage,
} from '../common/sandbox-activity-types';
import { SandboxClientProvider } from '../worker/sandbox-provider';
import { TemporalSandboxClient, temporalSandboxClient } from '../workflow/sandbox-client';
import { TemporalSandboxSession } from '../workflow/sandbox-session';
import { hasSandboxAgent, validateSandboxRunConfig } from '../workflow/runner';
import { FakeSandboxClient, FakeSandboxSession } from './stubs/sandbox-fakes';

function activityMap(provider: SandboxClientProvider): Record<string, (...args: any[]) => Promise<any>> {
  return provider._getActivities();
}

async function createSession(
  acts: Record<string, (...args: any[]) => Promise<any>>,
  name = 'fake'
): Promise<SandboxSessionResult> {
  return acts[`${name}${SANDBOX_CLIENT_CREATE_SUFFIX}`]!({});
}

// ── hasSandboxAgent ──

test('hasSandboxAgent: regular agent', (t) => {
  t.false(hasSandboxAgent(new Agent({ name: 'regular' })));
});

test('hasSandboxAgent: sandbox starting agent', (t) => {
  t.true(hasSandboxAgent(new SandboxAgent({ name: 'sandbox' })));
});

test('hasSandboxAgent: sandbox via direct handoff', (t) => {
  const sandbox = new SandboxAgent({ name: 'sandbox' });
  t.true(hasSandboxAgent(new Agent({ name: 'regular', handoffs: [sandbox] })));
});

test('hasSandboxAgent: sandbox via deep handoff', (t) => {
  const sandbox = new SandboxAgent({ name: 'sandbox' });
  const middle = new Agent({ name: 'middle', handoffs: [sandbox] });
  t.true(hasSandboxAgent(new Agent({ name: 'top', handoffs: [middle] })));
});

test('hasSandboxAgent: sandbox wrapped in Handoff', (t) => {
  const sandbox = new SandboxAgent({ name: 'sandbox' });
  t.true(hasSandboxAgent(new Agent({ name: 'regular', handoffs: [handoff(sandbox)] })));
});

test('hasSandboxAgent: no sandbox in chain', (t) => {
  const c = new Agent({ name: 'c' });
  const b = new Agent({ name: 'b', handoffs: [c] });
  t.false(hasSandboxAgent(new Agent({ name: 'a', handoffs: [b] })));
});

test('hasSandboxAgent: circular without sandbox', (t) => {
  const a = new Agent({ name: 'a' });
  const b = new Agent({ name: 'b', handoffs: [a] });
  a.handoffs = [b];
  t.false(hasSandboxAgent(a));
});

test('hasSandboxAgent: circular with sandbox', (t) => {
  const sandbox = new SandboxAgent({ name: 'sandbox' });
  const a = new Agent({ name: 'a', handoffs: [sandbox] });
  const b = new Agent({ name: 'b', handoffs: [a] });
  a.handoffs = [b, sandbox];
  t.true(hasSandboxAgent(b));
});

// ── temporalSandboxClient factory ──

test('temporalSandboxClient returns a TemporalSandboxClient with backendId = name', (t) => {
  const client = temporalSandboxClient('my-backend');
  t.true(client instanceof TemporalSandboxClient);
  t.is(client.backendId, 'my-backend');
});

test('temporalSandboxClient honors activity config overrides', (t) => {
  const client = temporalSandboxClient('my-backend', { config: { startToCloseTimeout: '10 minutes' } });
  t.is((client as any)._config.startToCloseTimeout, '10 minutes');
});

// ── validateSandboxRunConfig ──

test('validation: regular agent without sandbox config passes', (t) => {
  t.notThrows(() => validateSandboxRunConfig(new Agent({ name: 'regular' }), undefined));
});

test('validation: sandbox agent without sandbox config fails', (t) => {
  const err = t.throws(() => validateSandboxRunConfig(new SandboxAgent({ name: 'sandbox' }), undefined), {
    instanceOf: ApplicationFailure,
  });
  t.is(err?.type, 'SandboxConfigurationError');
  t.regex(err!.message, /runConfig\.sandbox is not configured/);
});

test('validation: handoff-reachable sandbox agent without sandbox config fails', (t) => {
  const sandbox = new SandboxAgent({ name: 'sandbox' });
  const router = new Agent({ name: 'router', handoffs: [sandbox] });
  t.throws(() => validateSandboxRunConfig(router, undefined), { instanceOf: ApplicationFailure });
});

test('validation: sandbox config without client fails', (t) => {
  const err = t.throws(() => validateSandboxRunConfig(new SandboxAgent({ name: 'sandbox' }), {}), {
    instanceOf: ApplicationFailure,
  });
  t.regex(err!.message, /runConfig\.sandbox\.client must be set/);
});

test('validation: raw sandbox client fails even without a sandbox agent', (t) => {
  const err = t.throws(
    () => validateSandboxRunConfig(new Agent({ name: 'regular' }), { client: new FakeSandboxClient() }),
    { instanceOf: ApplicationFailure }
  );
  t.regex(err!.message, /Do not pass a raw sandbox client directly/);
});

test('validation: temporal sandbox client passes', (t) => {
  t.notThrows(() =>
    validateSandboxRunConfig(new SandboxAgent({ name: 'sandbox' }), { client: temporalSandboxClient('fake') })
  );
});

// ── Provider activity registration ──

test('provider registers all prefixed activities', (t) => {
  const provider = new SandboxClientProvider('fake', new FakeSandboxClient());
  const names = Object.keys(provider._getActivities());
  t.deepEqual(new Set(names), new Set(SANDBOX_ACTIVITY_SUFFIXES.map((suffix) => `fake${suffix}`)));
});

test('multiple providers register disjoint activity sets', (t) => {
  const names1 = new Set(Object.keys(new SandboxClientProvider('daytona', new FakeSandboxClient())._getActivities()));
  const names2 = new Set(Object.keys(new SandboxClientProvider('local', new FakeSandboxClient())._getActivities()));
  t.is(names1.size, SANDBOX_ACTIVITY_SUFFIXES.length);
  t.is(names2.size, SANDBOX_ACTIVITY_SUFFIXES.length);
  for (const name of names1) {
    t.false(names2.has(name));
    t.true(name.startsWith('daytona-sandbox-'));
  }
});

// ── Provider delegation ──

test('create delegates to the real client and returns a serializable state handle', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));

  const manifest = new Manifest({ environment: { FOO: 'bar' } });
  const result: SandboxSessionResult = await acts[`fake${SANDBOX_CLIENT_CREATE_SUFFIX}`]!({
    manifest: encodeManifest(manifest),
  });

  t.is(client.createCalls.length, 1);
  t.true(client.createCalls[0]!.manifest instanceof Manifest);
  t.is(typeof result.state.sessionId, 'string');
  t.is(decodeManifest(result.state.manifest).environment.FOO!.value, 'bar');
  t.deepEqual(result.state.providerState, { workspacePath: '/tmp/fake-workspace' });
  t.false(result.supportsPty);
});

test('resume delegates to the real client', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  const result: SandboxSessionResult = await acts[`fake-sandbox-client-resume`]!({ state });
  t.is(client.resumeCalls, 1);
  t.is(result.state.sessionId, state.sessionId);
});

test('exec delegates to the real session', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  const result: SandboxExecResult = await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({
    state,
    args: { cmd: 'echo hello' },
  });
  t.is(result.stdout, 'ok');
  t.is(result.exitCode, 0);
  t.is(client.session.execCalls.length, 1);
  t.is(client.session.execCalls[0]!.cmd, 'echo hello');
});

test('execCommand, writeStdin, readFile, listDir, and pathExists delegate', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  t.is(await acts[`fake${SANDBOX_SESSION_EXEC_COMMAND_SUFFIX}`]!({ state, args: { cmd: 'ls' } }), 'ran:ls');
  t.is(await acts[`fake${SANDBOX_SESSION_WRITE_STDIN_SUFFIX}`]!({ state, args: { sessionId: 1, chars: 'y' } }), 'stdin:y');
  t.deepEqual(
    await acts[`fake${SANDBOX_SESSION_READ_FILE_SUFFIX}`]!({ state, args: { path: '/workspace/f' } }),
    new TextEncoder().encode('file-content')
  );
  const entries = await acts[`fake${SANDBOX_SESSION_LIST_DIR_SUFFIX}`]!({ state, args: { path: '/workspace' } });
  t.is(entries[0].name, 'file.txt');
  t.true(await acts[`fake${SANDBOX_SESSION_PATH_EXISTS_SUFFIX}`]!({ state, path: '/workspace/f' }));
});

test('materializeEntry decodes binary file content back to bytes', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);
  const content = new Uint8Array([0, 1, 254, 255]);

  await acts[`fake${SANDBOX_SESSION_MATERIALIZE_ENTRY_SUFFIX}`]!({
    state,
    path: 'bin/blob',
    entry: { type: 'file', content: { type: 'base64', data: bytesToBase64(content) } },
  });

  const materialized = client.session.materializedEntries[0]!;
  t.is(materialized.path, 'bin/blob');
  t.deepEqual((materialized.entry as { content: Uint8Array }).content, content);
});

test('applyManifest delegates with a decoded Manifest', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  await acts[`fake${SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX}`]!({
    state,
    manifest: encodeManifest(new Manifest({ entries: { 'a.txt': { type: 'file', content: 'hi' } } })),
  });

  t.is(client.session.appliedManifests.length, 1);
  t.true(client.session.appliedManifests[0] instanceof Manifest);
  t.deepEqual(Object.keys(client.session.appliedManifests[0]!.entries), ['a.txt']);
});

test('applyManifest falls back to materializeEntry when the real session lacks it', async (t) => {
  const session = new FakeSandboxSession();
  (session as { applyManifest?: unknown }).applyManifest = undefined;
  const client = new FakeSandboxClient(session);
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  await acts[`fake${SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX}`]!({
    state,
    manifest: encodeManifest(new Manifest({ entries: { 'a.txt': { type: 'file', content: 'hi' } } })),
  });

  t.is(session.materializedEntries.length, 1);
  t.is(session.materializedEntries[0]!.path, 'a.txt');
});

test('persistWorkspace applies archive limits and returns bytes', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  const data = await acts[`fake${SANDBOX_SESSION_PERSIST_WORKSPACE_SUFFIX}`]!({
    state,
    archiveLimits: { maxInputBytes: 1024 },
  });
  t.deepEqual(data, new Uint8Array([10, 20, 30]));
  t.deepEqual(client.session.archiveLimits, { maxInputBytes: 1024 });
});

test('hydrateWorkspace forwards archive bytes and options', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);
  const archive = new Uint8Array([9, 8, 7]);

  await acts[`fake${SANDBOX_SESSION_HYDRATE_WORKSPACE_SUFFIX}`]!({ state, archiveLimits: { maxMembers: 5 } }, archive);

  t.deepEqual(client.session.hydrateCalls[0]!.data, archive);
  t.deepEqual(client.session.hydrateCalls[0]!.archiveLimits, { maxMembers: 5 });
});

test('viewImage base64-encodes binary image data for transport', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  const serialized: SerializedToolOutputImage = await acts[`fake${SANDBOX_SESSION_VIEW_IMAGE_SUFFIX}`]!({
    state,
    args: { path: '/workspace/img.png' },
  });
  t.true(serialized.imageDataBase64);
  t.is(typeof (serialized.output.image as { data: string }).data, 'string');

  const decoded = decodeToolOutputImage(serialized);
  t.deepEqual((decoded.image as { data: Uint8Array }).data, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  t.is((decoded.image as { mediaType: string }).mediaType, 'image/png');
});

test('editor activities delegate to the real session editor', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  const result = await acts[`fake${SANDBOX_EDITOR_UPDATE_FILE_SUFFIX}`]!({
    state,
    operation: { type: 'update_file', path: 'a.txt', diff: '' },
  });
  t.deepEqual(result, { status: 'completed', output: 'update' });
  t.deepEqual(client.session.editorOperations, ['update:a.txt']);
});

test('lifecycle activities delegate; session delete evicts the cache', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  await acts[`fake${SANDBOX_SESSION_START_SUFFIX}`]!({ state });
  t.true(await acts[`fake${SANDBOX_SESSION_RUNNING_SUFFIX}`]!({ state }));
  await acts[`fake${SANDBOX_SESSION_STOP_SUFFIX}`]!({ state });
  await acts[`fake${SANDBOX_SESSION_SHUTDOWN_SUFFIX}`]!({ state });
  await acts[`fake${SANDBOX_SESSION_DELETE_SUFFIX}`]!({ state });

  t.is(client.session.startCalls, 1);
  t.is(client.session.stopCalls, 1);
  t.is(client.session.shutdownCalls, 1);
  t.is(client.session.deleteCalls, 1);

  // Cache was evicted at delete — the next operation self-heals via resume.
  t.is(client.resumeCalls, 0);
  await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'x' } });
  t.is(client.resumeCalls, 1);
});

test('client delete delegates and evicts the cache', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  await acts[`fake${SANDBOX_CLIENT_DELETE_SUFFIX}`]!({ state });
  t.is(client.deleteCalls, 1);

  t.is(client.resumeCalls, 0);
  await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'x' } });
  t.is(client.resumeCalls, 1);
});

test('serializeSessionState round-trips through deserializeSessionState', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  const record = await acts[`fake${SANDBOX_CLIENT_SERIALIZE_SESSION_STATE_SUFFIX}`]!({ state });
  t.is(record.sessionId, state.sessionId);
  t.deepEqual(record.providerState, { workspacePath: '/tmp/fake-workspace' });

  // The runtime merges envelope fields (manifest etc.) over this record before
  // handing it to the workflow client's pure deserializeSessionState.
  const restored = await temporalSandboxClient('fake').deserializeSessionState({
    ...record,
    manifest: state.manifest,
    workspaceReady: true,
  });
  t.is(restored.sessionId, state.sessionId);
  t.true(restored.manifest instanceof Manifest);
  t.deepEqual(restored.providerState, { workspacePath: '/tmp/fake-workspace' });
});

test('providerState fallback (no serializeSessionState) omits environment secrets and envelope fields', async (t) => {
  class NoSerializeClient extends FakeSandboxClient {
    // Inherits create/resume; deliberately drops the custom (de)serializers so
    // the provider falls back to its own state stripping.
    serializeSessionState = undefined as any;
    deserializeSessionState = undefined as any;
  }

  const session = new FakeSandboxSession();
  session.state = {
    manifest: new Manifest(),
    environment: { SECRET: 'topsecret' },
    snapshot: { id: 'snap', type: 'local' },
    workspaceReady: true,
    exposedPorts: { 'port:8080': { host: 'h', port: 8080 } },
    // The genuinely provider-specific key that must survive.
    workspaceId: 'abc-123',
  } as unknown as SandboxSessionState;
  const client = new NoSerializeClient(session);
  const acts = activityMap(new SandboxClientProvider('fake', client));

  const result = await createSession(acts);
  const ps = result.state.providerState;

  // No resolved env / secrets and no duplicated envelope fields in providerState.
  t.is(ps.environment, undefined);
  t.is(ps.manifest, undefined);
  t.is(ps.snapshot, undefined);
  t.is(ps.snapshotFingerprint, undefined);
  t.is(ps.snapshotFingerprintVersion, undefined);
  t.is(ps.workspaceReady, undefined);
  t.is(ps.exposedPorts, undefined);
  // The provider-specific key survives.
  t.is(ps.workspaceId, 'abc-123');
  // The secret must appear nowhere in the transported handle.
  t.false(JSON.stringify(result.state).includes('topsecret'));

  // The matching rehydrate fallback reconstructs the session correctly.
  const fresh = activityMap(new SandboxClientProvider('fake', client));
  await fresh[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state: result.state, args: { cmd: 'x' } });
  t.is(client.resumeCalls, 1);
  t.true(client.session.state.manifest instanceof Manifest);
  t.is((client.session.state as { workspaceId?: string }).workspaceId, 'abc-123');
  t.is(client.session.state.environment, undefined);
});

test('deserializeSessionState rejects records without a sessionId', async (t) => {
  const client = temporalSandboxClient('fake');
  const err = await t.throwsAsync(
    client.deserializeSessionState({ manifest: encodeManifest(new Manifest()), providerState: {} }),
    { instanceOf: ApplicationFailure }
  );
  t.is(err?.type, 'SandboxSessionStateInvalid');
});

// ── Session caching and resume-based self-heal ──

test('repeated operations reuse the cached session without resuming', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'one' } });
  await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'two' } });

  t.is(client.resumeCalls, 0);
  t.is(client.session.execCalls.length, 2);
});

test('a fresh provider (worker restart) self-heals via client.resume', async (t) => {
  const client = new FakeSandboxClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);

  // Simulate the activity retrying on a different worker: same real backend,
  // new provider instance with an empty session cache.
  const freshActs = activityMap(new SandboxClientProvider('fake', client));
  const result: SandboxExecResult = await freshActs[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({
    state,
    args: { cmd: 'after-restart' },
  });

  t.is(result.exitCode, 0);
  t.is(client.resumeCalls, 1);
  t.true(client.session.state.manifest instanceof Manifest);

  // Subsequent operations reuse the resumed session.
  await freshActs[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'again' } });
  t.is(client.resumeCalls, 1);
});

test('operations on an unknown session fail non-retryably when the client cannot resume', async (t) => {
  const client = new FakeSandboxClient();
  (client as { resume?: unknown }).resume = undefined;
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const state: SerializedSandboxSessionState = {
    sessionId: 'missing',
    manifest: encodeManifest(new Manifest()),
    workspaceReady: true,
    providerState: {},
  };

  const err = await t.throwsAsync(acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'x' } }), {
    instanceOf: ApplicationFailure,
  });
  t.is(err?.type, 'SandboxOperationUnsupported');
  t.true(err?.nonRetryable);
});

test('concurrent cache-miss operations on one session share a single resume', async (t) => {
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });

  class GatedResumeClient extends FakeSandboxClient {
    override async resume(state: SandboxSessionState): Promise<SandboxSession> {
      this.resumeCalls += 1;
      await resumeGate;
      this.session.state = state;
      return this.session;
    }
  }

  const client = new GatedResumeClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const state: SerializedSandboxSessionState = {
    sessionId: 'shared',
    manifest: encodeManifest(new Manifest()),
    workspaceReady: true,
    providerState: {},
  };

  // The agents run loop executes tools in parallel, so two Activities can
  // cache-miss the same session before either resume completes.
  const first = acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'a' } });
  const second = acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'b' } });
  releaseResume();
  await Promise.all([first, second]);

  t.is(client.resumeCalls, 1);
  t.is(client.session.execCalls.length, 2);
});

test('a failed resume is not memoized, so a later operation retries', async (t) => {
  let attempt = 0;
  class FlakyResumeClient extends FakeSandboxClient {
    override async resume(state: SandboxSessionState): Promise<SandboxSession> {
      this.resumeCalls += 1;
      attempt += 1;
      if (attempt === 1) throw new Error('resume failed');
      this.session.state = state;
      return this.session;
    }
  }

  const client = new FlakyResumeClient();
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const state: SerializedSandboxSessionState = {
    sessionId: 'retry',
    manifest: encodeManifest(new Manifest()),
    workspaceReady: true,
    providerState: {},
  };

  await t.throwsAsync(acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'a' } }), {
    message: 'resume failed',
  });
  await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'b' } });
  t.is(client.resumeCalls, 2);
});

test('session delete evicts the cache even when delete fails after shutdown', async (t) => {
  class DeleteRaisingSession extends FakeSandboxSession {
    override async delete(): Promise<void> {
      throw new Error('delete failed');
    }
  }

  const session = new DeleteRaisingSession();
  const client = new FakeSandboxClient(session);
  const provider = new SandboxClientProvider('fake', client);
  const acts = provider._getActivities();
  const { state } = await createSession(acts);

  await acts[`fake${SANDBOX_SESSION_SHUTDOWN_SUFFIX}`]!({ state });
  t.true((provider as any)._sessions.has(state.sessionId));

  await t.throwsAsync(acts[`fake${SANDBOX_SESSION_DELETE_SUFFIX}`]!({ state }), { message: 'delete failed' });
  t.is(session.shutdownCalls, 1);
  t.false((provider as any)._sessions.has(state.sessionId));
});

// ── SandboxError → ApplicationFailure translation ──

class ExecRaisingSession extends FakeSandboxSession {
  constructor(private readonly error: SandboxError) {
    super();
  }

  override async exec(): Promise<SandboxExecResult> {
    throw this.error;
  }
}

async function execWithError(error: SandboxError): Promise<void> {
  const client = new FakeSandboxClient(new ExecRaisingSession(error));
  const acts = activityMap(new SandboxClientProvider('fake', client));
  const { state } = await createSession(acts);
  await acts[`fake${SANDBOX_SESSION_EXEC_SUFFIX}`]!({ state, args: { cmd: 'boom' } });
}

test('terminal SandboxError (retryable false) becomes a non-retryable ApplicationFailure', async (t) => {
  const err = await t.throwsAsync(
    execWithError(new SandboxError('transport down', 'exec_transport_error', { retryable: false })),
    { instanceOf: ApplicationFailure }
  );
  t.true(err?.nonRetryable);
  t.is(err?.type, 'exec_transport_error');
});

test('transient SandboxError (retryable true) propagates unchanged', async (t) => {
  await t.throwsAsync(execWithError(new SandboxError('flaky', 'exec_transport_error', { retryable: true })), {
    instanceOf: SandboxError,
  });
});

test('unclassified SandboxError (retryable null) propagates unchanged', async (t) => {
  const error = new SandboxError('unknown', 'exec_transport_error');
  t.is(error.retryable, null);
  await t.throwsAsync(execWithError(error), { instanceOf: SandboxError });
});

// ── Workflow-side sync touch-points ──

function makeWorkflowSession(supportsPty = true): TemporalSandboxSession {
  return new TemporalSandboxSession(
    'fake',
    { startToCloseTimeout: '5 minutes' },
    {
      sessionId: 'session-1',
      manifest: new Manifest({ environment: { FOO: 'bar' } }),
      workspaceReady: true,
      providerState: { workspacePath: '/tmp/fake-workspace' },
    },
    supportsPty
  );
}

test('session state (including manifest) is served synchronously from cached state', (t) => {
  const session = makeWorkflowSession();
  t.true(session.state.manifest instanceof Manifest);
  t.is(session.state.manifest.environment.FOO!.value, 'bar');
  t.is(session.state.sessionId, 'session-1');
});

test('createEditor returns an editor synchronously', (t) => {
  const editor = makeWorkflowSession().createEditor('someone');
  t.is(typeof editor.createFile, 'function');
  t.is(typeof editor.updateFile, 'function');
  t.is(typeof editor.deleteFile, 'function');
});

test('supportsPty is served from the cached flag', (t) => {
  t.true(makeWorkflowSession(true).supportsPty());
  t.false(makeWorkflowSession(false).supportsPty());
});

test('setArchiveLimits mutates local cached state only', (t) => {
  const session = makeWorkflowSession();
  session.setArchiveLimits({ maxInputBytes: 42 });
  t.deepEqual((session as any)._archiveLimits, { maxInputBytes: 42 });
  session.setArchiveLimits(null);
  t.is((session as any)._archiveLimits, null);
});

test('registerPreStopHook is not implemented on the proxy session', (t) => {
  const session: SandboxSession = makeWorkflowSession();
  t.is(session.registerPreStopHook, undefined);
});

// ── Serialization round-trips ──

const BYTE_PAYLOADS: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['ascii', new TextEncoder().encode('hello world')],
  ['all-byte-values', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))],
  ['non-utf8-binary', new Uint8Array([0xff, 0xfe, 0x80, 0x90, 0x00, 0x01])],
  ['one-byte', new Uint8Array([7])],
  ['two-bytes', new Uint8Array([7, 8])],
];

test('base64 helpers round-trip binary payloads and match Buffer', (t) => {
  for (const [label, payload] of BYTE_PAYLOADS) {
    const encoded = bytesToBase64(payload);
    t.is(encoded, Buffer.from(payload).toString('base64'), label);
    t.deepEqual(base64ToBytes(encoded), payload, label);
  }
});

test('encodeManifest keeps binary content, drops ephemeral entries/env, and is SDK-decodable', (t) => {
  const content = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const manifest = new Manifest({
    root: '/workspace',
    entries: {
      'bin/blob': { type: 'file', content },
      'tmp/scratch': { type: 'file', content: 'scratch', ephemeral: true },
      nested: { type: 'dir', children: { 'inner.bin': { type: 'file', content } } },
    },
    environment: { API_KEY: { value: 'secret', ephemeral: true }, PLAIN: 'value' },
    users: ['alice'],
  });

  const record = JSON.parse(JSON.stringify(encodeManifest(manifest)));
  // Our own decoder and the SDK's own deserializer both accept the encoded form.
  t.true(decodeManifest(record) instanceof Manifest);
  const decoded = deserializeManifest(record);

  t.is(decoded.root, '/workspace');
  // Non-ephemeral binary content survives the JSON round-trip.
  t.deepEqual((decoded.entries['bin/blob'] as { content: Uint8Array }).content, content);
  const nested = decoded.entries['nested'] as { children: Record<string, { content: Uint8Array }> };
  t.deepEqual(nested.children['inner.bin']!.content, content);
  // Ephemeral entries and env values (secrets) are dropped from the persisted form.
  t.is(decoded.entries['tmp/scratch'], undefined);
  t.is(decoded.environment.API_KEY, undefined);
  t.is(decoded.environment.PLAIN!.value, 'value');
  t.deepEqual(decoded.users, [{ name: 'alice' }]);
});

test('session envelope survives a JSON round-trip and revives a live Manifest', (t) => {
  const state = {
    sessionId: 'abc',
    manifest: new Manifest({ environment: { FOO: 'bar' } }),
    snapshot: { id: 'snap-1', type: 'local' },
    workspaceReady: false,
    exposedPorts: { 'port:8080': { host: 'localhost', port: 8080 } },
    providerState: { workspacePath: '/tmp/w' },
  };

  const payload = JSON.parse(JSON.stringify(serializeSessionEnvelope(state.sessionId, state, state.providerState)));
  const decoded = reviveWorkflowSessionState(payload);

  t.is(decoded.sessionId, 'abc');
  t.true(decoded.manifest instanceof Manifest);
  t.is(decoded.manifest.environment.FOO!.value, 'bar');
  t.deepEqual(decoded.snapshot, { id: 'snap-1', type: 'local' });
  t.false(decoded.workspaceReady);
  t.deepEqual(decoded.exposedPorts, { 'port:8080': { host: 'localhost', port: 8080 } });
  t.deepEqual(decoded.providerState, { workspacePath: '/tmp/w' });
});
