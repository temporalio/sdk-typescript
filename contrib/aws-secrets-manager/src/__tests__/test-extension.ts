import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import test from 'ava';
import type { Connection, ConnectionOptions } from '@temporalio/client';
import { Connection as RealConnection } from '@temporalio/client';
import type { ClientConfigExtensionPlugin, LoadClientConnectConfigOptions } from '@temporalio/envconfig';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import type { NativeConnection, NativeConnectionOptions } from '@temporalio/worker';
import { NativeConnection as RealNativeConnection, Runtime } from '@temporalio/worker';
import type { SecretCache } from '../cache';
import { FAILED_REFRESH_RETRY_INTERVAL_MS, SecretFetchError } from '../cache';
import type { SecretsManagerExtensionOptions } from '../extension';
import { SecretsManagerExtension } from '../extension';
import type { LogEntry } from './helpers';
import { TEST_CERT_A, TEST_KEY_A, recordingLogger, waitUntil } from './helpers';

// The runtime logger is process-wide, so tests that check logs are serial (run before the concurrent
// tests, one at a time) and clear the logs first
const logs: LogEntry[] = [];

test.before(() => {
  Runtime.install({ logger: recordingLogger(logs) });
});

/** A fake Secrets Manager client that returns `secrets`, counting fetches of each. */
class FakeSecrets {
  readonly secrets = new Map<string, string | Error>();
  readonly calls = new Map<string, number>();
  private version = 0;

  readonly client = {
    send: async (command: GetSecretValueCommand) => {
      if (!(command instanceof GetSecretValueCommand)) {
        throw new Error('unexpected command');
      }
      const id = command.input.SecretId!;
      this.calls.set(id, (this.calls.get(id) ?? 0) + 1);
      const value = this.secrets.get(id);
      if (value === undefined) {
        throw Object.assign(new Error(`no secret ${id}`), { name: 'ResourceNotFoundException' });
      }
      if (value instanceof Error) {
        throw value;
      }
      return { SecretString: value, VersionId: `v${++this.version}` };
    },
  } as unknown as SecretsManagerClient;

  constructor(secrets: Record<string, string> = {}) {
    for (const [id, value] of Object.entries(secrets)) {
      this.secrets.set(id, value);
    }
  }
}

interface Loaded {
  plugin: TestPlugin | undefined;
  ids?: Record<string, string>;
}

type TestPlugin = ClientConfigExtensionPlugin & {
  connect(options: ConnectionOptions, next: (o: ConnectionOptions) => Promise<Connection>): Promise<Connection>;
  connectNative(
    options: NativeConnectionOptions,
    next: (o: NativeConnectionOptions) => Promise<NativeConnection>
  ): Promise<NativeConnection>;
  minRefreshIntervalMs: number;
};

function load(
  toml: string,
  env: Record<string, string> = {},
  options: SecretsManagerExtensionOptions = {},
  loadOptions: Partial<LoadClientConnectConfigOptions> = {}
): Loaded {
  const config = loadClientConnectConfig({
    configSource: { data: toml },
    overrideEnvVars: env,
    extensions: [new SecretsManagerExtension({ secretsClient: new FakeSecrets().client, ...options })],
    ...loadOptions,
  });
  const plugin = config.connectionOptions.plugins?.[0] as TestPlugin | undefined;
  return { plugin, ids: plugin && { ...(plugin as any).ids } };
}

const PROFILE = '[profile.default]\naddress = "localhost:7233"\n';

test('no secret IDs means no plugin', (t) => {
  t.is(load(PROFILE).plugin, undefined);
  t.is(load(`${PROFILE}[profile.default.ext.aws_secrets_manager]\n`).plugin, undefined);
});

test('secret IDs are loaded from TOML and env', (t) => {
  const toml = `${PROFILE}
[profile.default.ext.aws_secrets_manager]
api_key_id = "toml-api-key"
[profile.default.ext.aws_secrets_manager.tls]
client_cert_id = "toml-cert"
client_key_id = "toml-key"
server_ca_cert_id = "toml-ca"
`;
  t.deepEqual(load(toml).ids, {
    apiKey: 'toml-api-key',
    clientCert: 'toml-cert',
    clientKey: 'toml-key',
    serverCACert: 'toml-ca',
  });
  // Env vars override the file, and set-but-empty env vars unset it
  t.deepEqual(
    load(toml, {
      TEMPORAL_EXT_AWS_SECRETS_MANAGER_API_KEY_ID: 'env-api-key',
      TEMPORAL_EXT_AWS_SECRETS_MANAGER_TLS_SERVER_CA_CERT_ID: '',
    }).ids,
    { apiKey: 'env-api-key', clientCert: 'toml-cert', clientKey: 'toml-key', serverCACert: '' }
  );
  t.deepEqual(
    load(PROFILE, {
      TEMPORAL_EXT_AWS_SECRETS_MANAGER_TLS_CLIENT_CERT_ID: 'env-cert',
      TEMPORAL_EXT_AWS_SECRETS_MANAGER_TLS_CLIENT_KEY_ID: 'env-key',
    }).ids,
    { apiKey: '', clientCert: 'env-cert', clientKey: 'env-key', serverCACert: '' }
  );
  // Env vars are ignored when env loading is disabled
  t.is(
    load(PROFILE, { TEMPORAL_EXT_AWS_SECRETS_MANAGER_API_KEY_ID: 'id' }, {}, { disableEnv: true }).plugin,
    undefined
  );
});

const EXT = '[profile.default.ext.aws_secrets_manager]';
const EXT_TLS = '[profile.default.ext.aws_secrets_manager.tls]';

for (const [name, toml, env, message] of [
  ['unknown key', `${EXT}\nfoo = "x"`, {}, 'unknown key "foo" in ext.aws_secrets_manager'],
  ['unknown TLS key', `${EXT_TLS}\nfoo = "x"`, {}, 'unknown key "foo" in ext.aws_secrets_manager.tls'],
  ['TLS not a table', `${EXT}\ntls = "x"`, {}, 'ext.aws_secrets_manager.tls must be a table, got string'],
  ['non-string ID', `${EXT}\napi_key_id = 1`, {}, 'ext.aws_secrets_manager.api_key_id must be a string, got number'],
  [
    'non-string TLS ID',
    `${EXT_TLS}\nclient_cert_id = []`,
    {},
    'ext.aws_secrets_manager.tls.client_cert_id must be a string, got array',
  ],
  [
    'API key conflict',
    `api_key = "key"\n${EXT}\napi_key_id = "id"`,
    {},
    'invalid config: API key secret ID cannot be set with an API key',
  ],
  [
    'API key conflict across sources',
    'api_key = "key"',
    { TEMPORAL_EXT_AWS_SECRETS_MANAGER_API_KEY_ID: 'id' },
    'invalid config: API key secret ID cannot be set with an API key',
  ],
  [
    'client cert conflict',
    `[profile.default.tls]\nclient_cert_data = "x"\nclient_key_data = "y"\n${EXT_TLS}\nclient_cert_id = "c"\nclient_key_id = "k"`,
    {},
    'invalid config: TLS client cert secret ID cannot be set with client cert path or data; ' +
      'TLS client key secret ID cannot be set with client key path or data',
  ],
  [
    'server CA cert conflict',
    `[profile.default.tls]\nserver_ca_cert_data = "x"\n${EXT_TLS}\nserver_ca_cert_id = "ca"`,
    {},
    'invalid config: TLS server CA cert secret ID cannot be set with server CA cert path or data',
  ],
  [
    'TLS disabled',
    `[profile.default.tls]\ndisabled = true\n${EXT_TLS}\nserver_ca_cert_id = "ca"`,
    {},
    'invalid config: TLS secret IDs cannot be set when TLS is disabled',
  ],
  [
    'cert without key',
    `${EXT_TLS}\nclient_cert_id = "c"`,
    {},
    'invalid config: TLS client cert and key secret IDs must be set together',
  ],
] as const) {
  test(`invalid config: ${name}`, (t) => {
    t.throws(() => load(`${PROFILE}${toml}\n`, env), {
      message: `client config extension "aws_secrets_manager": ${message}`,
    });
  });
}

test('API key secret is allowed with TLS disabled', (t) => {
  const { plugin } = load(`${PROFILE}[profile.default.tls]\ndisabled = true\n${EXT}\napi_key_id = "id"\n`);
  t.not(plugin, undefined);
});

function cacheSettings(plugin: TestPlugin | undefined): [number, number] {
  const cache = (plugin as any).cache;
  return [cache.refreshIntervalMs, cache.maxStalenessMs];
}

const API_KEY_PROFILE = `${PROFILE}${EXT}\napi_key_id = "id"\n`;

test.serial('refresh interval and max staleness', (t) => {
  const prevTTL = process.env['SECRETS_MANAGER_TTL'];
  try {
    delete process.env['SECRETS_MANAGER_TTL'];
    t.deepEqual(cacheSettings(load(API_KEY_PROFILE).plugin), [5 * 60_000, 24 * 3_600_000]);
    t.deepEqual(
      cacheSettings(load(API_KEY_PROFILE, {}, { refreshInterval: '1m', maxStaleness: '1h' }).plugin),
      [60_000, 3_600_000]
    );
    // Max staleness is at least the refresh interval, including when it's 0
    t.deepEqual(cacheSettings(load(API_KEY_PROFILE, {}, { refreshInterval: '2h', maxStaleness: '1h' }).plugin), [
      2 * 3_600_000,
      2 * 3_600_000,
    ]);
    t.deepEqual(
      cacheSettings(load(API_KEY_PROFILE, {}, { refreshInterval: '1m', maxStaleness: 0 }).plugin),
      [60_000, 60_000]
    );
    for (const maxStaleness of [-1, NaN]) {
      t.throws(() => load(API_KEY_PROFILE, {}, { maxStaleness }), {
        message: /maxStaleness must be a non-negative duration/,
      });
    }
    for (const refreshInterval of [-1, NaN, Infinity]) {
      t.throws(() => load(API_KEY_PROFILE, {}, { refreshInterval }), {
        message: /refreshInterval must be a finite, non-negative duration/,
      });
    }

    process.env['SECRETS_MANAGER_TTL'] = '0';
    t.deepEqual(cacheSettings(load(API_KEY_PROFILE).plugin)[0], 0);
    process.env['SECRETS_MANAGER_TTL'] = '600';
    t.deepEqual(cacheSettings(load(API_KEY_PROFILE).plugin)[0], 600_000);
    // The option takes precedence
    t.deepEqual(cacheSettings(load(API_KEY_PROFILE, {}, { refreshInterval: 1000 }).plugin)[0], 1000);
    for (const invalid of ['-1', '1.5', 'abc', '9'.repeat(20)]) {
      process.env['SECRETS_MANAGER_TTL'] = invalid;
      t.throws(() => load(API_KEY_PROFILE), {
        message: `client config extension "aws_secrets_manager": invalid SECRETS_MANAGER_TTL "${invalid}", must be a non-negative whole number of seconds`,
      });
    }
  } finally {
    if (prevTTL === undefined) delete process.env['SECRETS_MANAGER_TTL'];
    else process.env['SECRETS_MANAGER_TTL'] = prevTTL;
  }
});

const ALL_PROFILE = `${PROFILE}${EXT}
api_key_id = "api-key"
[profile.default.ext.aws_secrets_manager.tls]
client_cert_id = "bundle"
client_key_id = "bundle"
server_ca_cert_id = "ca"
`;

function allSecrets(): FakeSecrets {
  return new FakeSecrets({ 'api-key': 'secret-key', bundle: TEST_CERT_A + TEST_KEY_A, ca: TEST_CERT_A });
}

/** A `next` function that records the options it was called with and returns `result`. */
function recordingNext<O, C>(result: C): { next: (options: O) => Promise<C>; calls: O[] } {
  const calls: O[] = [];
  return { next: async (options) => (calls.push(options), result), calls };
}

test('connect applies secrets to Connection options', async (t) => {
  const { plugin } = load(ALL_PROFILE, {}, { secretsClient: allSecrets().client });
  const conn = {} as Connection;
  const { next, calls } = recordingNext<ConnectionOptions, Connection>(conn);
  t.is(await plugin!.connect({ address: 'host:7233', tls: { serverNameOverride: 'sni' } }, next), conn);

  const options = calls[0]!;
  t.is(options.address, 'host:7233');
  t.is(typeof options.apiKey, 'function');
  t.is((options.apiKey as () => string)(), 'secret-key');
  t.like(options.tls, { serverNameOverride: 'sni' });
  const tls = options.tls as unknown as {
    clientCertPair: { crt: Buffer; key: Buffer };
    serverRootCACertificate: Buffer;
  };
  t.is(tls.clientCertPair.crt.toString(), TEST_CERT_A);
  t.is(tls.clientCertPair.key.toString(), TEST_KEY_A);
  t.is(tls.serverRootCACertificate.toString(), TEST_CERT_A);
});

test.serial('connectNative applies secrets to NativeConnection options', async (t) => {
  logs.length = 0;
  const { plugin } = load(ALL_PROFILE, {}, { secretsClient: allSecrets().client });
  const conn = { setApiKey: async () => undefined } as unknown as NativeConnection;
  const { next, calls } = recordingNext<NativeConnectionOptions, NativeConnection>(conn);
  t.is(await plugin!.connectNative({ address: 'host:7233' }, next), conn);

  const options = calls[0]!;
  t.is(options.apiKey, 'secret-key');
  const tls = options.tls as unknown as { clientCertPair: { crt: Buffer }; serverRootCACertificate: Buffer };
  t.is(tls.clientCertPair.crt.toString(), TEST_CERT_A);
  t.is(tls.serverRootCACertificate.toString(), TEST_CERT_A);
  t.true(logs.some((l) => l.message === 'Fetched AWS Secrets Manager secret' && l.meta?.secretId === 'api-key'));
});

test('API key secret leaves TLS as is', async (t) => {
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: new FakeSecrets({ id: 'key' }).client });
  const { next, calls } = recordingNext<NativeConnectionOptions, NativeConnection>({} as NativeConnection);
  await plugin!.connectNative({}, next);
  // Unset, so that the API key enables TLS by default
  t.is(calls[0]!.tls, undefined);
});

for (const [name, options, message] of [
  ['API key', { apiKey: 'key' }, 'cannot use API key from AWS Secrets Manager, API key already set'],
  ['TLS disabled', { tls: false }, 'cannot use TLS config from AWS Secrets Manager, TLS is disabled'],
  [
    'client cert',
    { tls: { clientCertPair: { crt: Buffer.from(''), key: Buffer.from('') } } },
    'cannot use TLS client cert from AWS Secrets Manager, client certificates already set',
  ],
  [
    'server CA cert',
    { tls: { serverRootCACertificate: Buffer.from('') } },
    'cannot use TLS server CA cert from AWS Secrets Manager, server root CA cert already set',
  ],
] as const) {
  test(`connect conflicts: ${name}`, async (t) => {
    const { plugin } = load(ALL_PROFILE, {}, { secretsClient: allSecrets().client });
    const { next, calls } = recordingNext<ConnectionOptions, Connection>({} as Connection);
    await t.throwsAsync(plugin!.connect(options, next), { message });
    await t.throwsAsync(plugin!.connectNative(options as NativeConnectionOptions, next as any), { message });
    t.is(calls.length, 0);
  });
}

test('connect fails if a fetch fails', async (t) => {
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: new FakeSecrets().client });
  const { next, calls } = recordingNext<NativeConnectionOptions, NativeConnection>({} as NativeConnection);
  await t.throwsAsync(plugin!.connectNative({}, next), {
    instanceOf: SecretFetchError,
    message: 'failed fetching AWS Secrets Manager secret "id": no secret id',
  });
  t.is(calls.length, 0);
});

/** A fake NativeConnection that records API key updates, and fails them once closed. */
function fakeNativeConnection(): { conn: NativeConnection; updates: string[]; close: () => void } {
  const updates: string[] = [];
  let closed = false;
  const conn = {
    async setApiKey(key: string) {
      if (closed) throw new Error('Client already closed');
      updates.push(key);
    },
  } as unknown as NativeConnection;
  return { conn, updates, close: () => (closed = true) };
}

test.serial('NativeConnection API key is refreshed in the background until the connection is closed', async (t) => {
  logs.length = 0;
  const secrets = new FakeSecrets({ id: 'key1' });
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: secrets.client, refreshInterval: 0 });
  plugin!.minRefreshIntervalMs = 20;
  const { conn, updates, close } = fakeNativeConnection();
  await plugin!.connectNative({}, async () => conn);

  secrets.secrets.set('id', 'key2');
  await waitUntil(() => updates.includes('key2'));
  t.true(logs.some((l) => l.message === 'Updated client API key from AWS Secrets Manager'));

  // With an unchanged key, refreshing must stop because the connection is closed, not because
  // updating the key failed
  close();
  const callsAtClose = secrets.calls.get('id')!;
  await new Promise((resolve) => setTimeout(resolve, 200));
  // At most a refresh that was already in progress, rather than one every 20ms
  t.true(secrets.calls.get('id')! <= callsAtClose + 1);
  // The plugin only holds the connection weakly
  t.truthy(conn);
});

test('NativeConnection API key is kept when a background refresh fails', async (t) => {
  const secrets = new FakeSecrets({ id: 'key1' });
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: secrets.client, refreshInterval: 0 });
  plugin!.minRefreshIntervalMs = 20;
  const { conn, updates, close } = fakeNativeConnection();
  await plugin!.connectNative({}, async () => conn);

  secrets.secrets.set('id', new Error('down'));
  await waitUntil(() => secrets.calls.get('id')! > 1);
  // The loop keeps going after the failure
  const updatesAfterFailure = updates.length;
  await waitUntil(() => updates.length > updatesAfterFailure);
  t.deepEqual(new Set(updates), new Set(['key1']));
  close();
});

test.serial('NativeConnection API key is removed past max staleness', async (t) => {
  logs.length = 0;
  const secrets = new FakeSecrets({ id: 'key1' });
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: secrets.client, refreshInterval: 0 });
  plugin!.minRefreshIntervalMs = 20;
  const cache = (plugin as any).cache as SecretCache;
  let now = 0;
  cache.now = () => now;
  const { conn, updates, close } = fakeNativeConnection();
  await plugin!.connectNative({}, async () => conn);

  secrets.secrets.set('id', new Error('down'));
  now += cache.maxStalenessMs + 1;
  // NativeConnection can't unset its key, so it's set to an empty one
  await waitUntil(() => updates[updates.length - 1] === '');
  t.true(logs.some((l) => l.message === 'Removed client API key, no AWS Secrets Manager value within max staleness'));

  // A successful refresh sets the key again
  secrets.secrets.set('id', 'key2');
  await waitUntil(() => updates[updates.length - 1] === 'key2');
  close();
});

test.serial('NativeConnection API key is removed on an unexpected refresh error', async (t) => {
  logs.length = 0;
  const secrets = new FakeSecrets({ id: 'key1' });
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: secrets.client, refreshInterval: 0 });
  plugin!.minRefreshIntervalMs = 20;
  const cache = (plugin as any).cache as SecretCache;
  const now = cache.now;
  const { conn, updates, close } = fakeNativeConnection();
  await plugin!.connectNative({}, async () => conn);

  // Not a fetch failure, so a bug in the cache
  cache.now = () => {
    throw new Error('bug');
  };
  await waitUntil(() => updates[updates.length - 1] === '');
  t.true(logs.some((l) => l.message === 'Unexpected error refreshing client API key from AWS Secrets Manager'));

  // Refreshing continues
  cache.now = now;
  secrets.secrets.set('id', 'key2');
  await waitUntil(() => updates[updates.length - 1] === 'key2');
  close();
});

test('Connection API key is removed past max staleness', async (t) => {
  const secrets = new FakeSecrets({ id: 'key1' });
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: secrets.client, refreshInterval: 0 });
  plugin!.minRefreshIntervalMs = 20;
  const cache = (plugin as any).cache as SecretCache;
  let now = 0;
  cache.now = () => now;
  const { next, calls } = recordingNext<ConnectionOptions, Connection>({} as Connection);
  await plugin!.connect({}, next);
  const apiKey = calls[0]!.apiKey as () => string;
  t.is(apiKey(), 'key1');

  // Kept while refreshing, then an empty key sends no Authorization header once the refresh fails
  secrets.secrets.set('id', new Error('down'));
  now += cache.maxStalenessMs;
  t.is(apiKey(), 'key1');
  await waitUntil(() => cache.apiKey!.inFlight === undefined);
  t.is(apiKey(), '');

  // A successful refresh sets the key again
  secrets.secrets.set('id', 'key2');
  now += FAILED_REFRESH_RETRY_INTERVAL_MS;
  t.is(apiKey(), '');
  await waitUntil(() => cache.apiKey!.inFlight === undefined);
  t.is(apiKey(), 'key2');
});

test('Connection API key is refreshed when used', async (t) => {
  const secrets = new FakeSecrets({ id: 'key1' });
  const { plugin } = load(API_KEY_PROFILE, {}, { secretsClient: secrets.client, refreshInterval: 0 });
  plugin!.minRefreshIntervalMs = 20;
  const cache = (plugin as any).cache as SecretCache;
  let now = 0;
  cache.now = () => now;
  const { next, calls } = recordingNext<ConnectionOptions, Connection>({} as Connection);
  await plugin!.connect({}, next);
  const apiKey = calls[0]!.apiKey as () => string;
  t.is(apiKey(), 'key1');

  // Not refreshed until the minimum refresh interval has passed
  secrets.secrets.set('id', 'key2');
  now += 19;
  t.is(apiKey(), 'key1');
  t.is(cache.apiKey!.inFlight, undefined);

  // Then refreshed in the background, returning the current key meanwhile
  now += 1;
  t.is(apiKey(), 'key1');
  t.not(cache.apiKey!.inFlight, undefined);
  await waitUntil(() => cache.apiKey!.inFlight === undefined);
  t.is(apiKey(), 'key2');
  t.is(secrets.calls.get('id'), 2);
});

test('NativeConnection.connect runs the plugin', async (t) => {
  const secrets = allSecrets();
  const { plugin } = load(ALL_PROFILE, {}, { secretsClient: secrets.client });
  // Nothing listening, so connecting fails after the plugin has applied its options
  const err = await t.throwsAsync(
    RealNativeConnection.connect({ address: '127.0.0.1:1', plugins: [plugin!], connectTimeout: '1s' } as any)
  );
  t.notRegex(err!.message, /AWS Secrets Manager/);
  t.is(secrets.calls.get('api-key'), 1);
  t.is(secrets.calls.get('bundle'), 1);
  t.is(secrets.calls.get('ca'), 1);
});

test('Connection.connect runs the plugin', async (t) => {
  const secrets = allSecrets();
  const { plugin } = load(ALL_PROFILE, {}, { secretsClient: secrets.client });
  const err = await t.throwsAsync(
    RealConnection.connect({ address: '127.0.0.1:1', plugins: [plugin!], connectTimeout: '100ms' })
  );
  t.notRegex(err!.message, /AWS Secrets Manager/);
  t.is(secrets.calls.get('api-key'), 1);
  t.is(secrets.calls.get('bundle'), 1);
});
