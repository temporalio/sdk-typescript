import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'ava';
import dedent from 'dedent';
import type { ConnectionOptions } from '@temporalio/client';
import type { NativeConnectionOptions } from '@temporalio/worker';
import type {
  ClientConfigExtension,
  ClientConfigExtensionPlugin,
  ClientConfigExtensionRequest,
  ConfigDataSource,
} from '../index';
import { clientConfigToToml, loadClientConfig, loadClientConfigProfile, loadClientConnectConfig } from '../index';

function dataSource(data: string): ConfigDataSource {
  return { data };
}

function testExtension(
  name: string,
  clientPlugin: (request: ClientConfigExtensionRequest) => ClientConfigExtensionPlugin | undefined
): ClientConfigExtension {
  return { name, clientPlugin };
}

function testPlugin(name: string): ClientConfigExtensionPlugin {
  return { name };
}

// =============================================================================
// 📄 EXT PARSING
// =============================================================================

const TOML_CONFIG_EXT = dedent`
  [profile.default]
  address = "default-address"
  [profile.default.ext.first]
  value = "first-value"
  nested = { list = [1, 2], flag = true }
  [profile.default.ext.second]
  [profile.default.ext.second.deeper]
  value = 5

  [profile.other]
  address = "other-address"
`;

for (const strict of [false, true]) {
  test(`Load profile with ext (strict: ${strict})`, (t) => {
    const profile = loadClientConfigProfile({ configSource: dataSource(TOML_CONFIG_EXT), configFileStrict: strict });
    t.is(profile.address, 'default-address');
    t.deepEqual(profile.ext, {
      first: { value: 'first-value', nested: { list: [1, 2], flag: true } },
      second: { deeper: { value: 5 } },
    });

    const config = loadClientConfig({ configSource: dataSource(TOML_CONFIG_EXT), configFileStrict: strict });
    t.deepEqual(config.profiles['default']?.ext, profile.ext);
    t.is(config.profiles['other']?.ext, undefined);
  });
}

test('Strict mode still rejects unknown non-ext keys alongside ext', (t) => {
  const toml = dedent`
    [profile.default]
    unrecognized_field = "should-fail"
    [profile.default.ext.first]
    value = "first-value"
  `;
  const err = t.throws(() => loadClientConfigProfile({ configSource: dataSource(toml), configFileStrict: true }));
  t.true(String(err?.message).includes('unrecognized_field'));
});

test('ext round-trips through TOML', (t) => {
  const config = loadClientConfig({ configSource: dataSource(TOML_CONFIG_EXT) });
  const roundTripped = loadClientConfig({
    configSource: dataSource(Buffer.from(clientConfigToToml(config)).toString()),
  });
  t.deepEqual(roundTripped, config);
  t.is(roundTripped.profiles['other']?.ext, undefined);
});

// =============================================================================
// 🧩 EXTENSIONS
// =============================================================================

test('loadClientConnectConfig calls extensions in order and appends plugins', (t) => {
  const env = { TEMPORAL_ADDRESS: 'env-address', TEMPORAL_EXT_FIRST_VALUE: 'env-value' };
  const calls: string[] = [];
  const first = testExtension('first', (req) => {
    calls.push('first');
    // Env vars have already been applied to the profile
    t.is(req.profile.address, 'env-address');
    t.deepEqual(req.profile.ext?.['first'], { value: 'file-value' });
    t.is(req.env, env);
    return testPlugin(`first-${req.env?.['TEMPORAL_EXT_FIRST_VALUE']}`);
  });
  const noop = testExtension('noop', (req) => {
    calls.push('noop');
    t.is(req.profile.ext?.['noop'], undefined);
    return undefined;
  });
  const second = testExtension('second', () => {
    calls.push('second');
    return testPlugin('second');
  });

  const { connectionOptions } = loadClientConnectConfig({
    configSource: dataSource(dedent`
      [profile.default]
      address = "file-address"
      [profile.default.ext.first]
      value = "file-value"
    `),
    configFileStrict: true,
    overrideEnvVars: env,
    extensions: [second, first, noop],
  });
  t.deepEqual(calls, ['second', 'first', 'noop']); // extension order is respected
  t.deepEqual(
    connectionOptions.plugins?.map((p) => p.name),
    ['second', 'first-env-value']
  );
  t.is(connectionOptions.address, 'env-address');
});

test('loadClientConnectConfig leaves plugins unset without extensions', (t) => {
  for (const extensions of [undefined, []]) {
    const { connectionOptions } = loadClientConnectConfig({
      configSource: dataSource(TOML_CONFIG_EXT),
      overrideEnvVars: {},
      extensions,
    });
    t.is(connectionOptions.plugins, undefined);
  }
});

test('loadClientConnectConfig passes env to extensions', (t) => {
  const gotEnvs: ClientConfigExtensionRequest['env'][] = [];
  const ext = testExtension('ext', (req) => {
    gotEnvs.push(req.env);
    return undefined;
  });
  const env = { TEMPORAL_EXT_EXT_VALUE: 'value' };

  // Defaults to process env
  loadClientConnectConfig({ configSource: dataSource('[profile.default]'), extensions: [ext] });
  // Uses override env when given
  loadClientConnectConfig({ configSource: dataSource('[profile.default]'), overrideEnvVars: env, extensions: [ext] });
  // Undefined when env is disabled
  loadClientConnectConfig({
    configSource: dataSource('[profile.default]'),
    disableEnv: true,
    overrideEnvVars: env,
    extensions: [ext],
  });

  t.is(gotEnvs.length, 3);
  t.is(gotEnvs[0], process.env);
  t.is(gotEnvs[1], env);
  t.is(gotEnvs[2], undefined);
});

test('loadClientConnectConfig rejects invalid extensions before calling any', (t) => {
  const newExt = (name: string) =>
    testExtension(name, () => {
      t.fail('extension should not be called');
      return undefined;
    });
  const cases: [string, ClientConfigExtension[], string][] = [
    ['duplicate', [newExt('a'), newExt('b'), newExt('a')], 'duplicate client config extension name "a"'],
    ['empty name', [newExt('a'), newExt('')], 'client config extension at index 1 has empty name'],
    ['undefined', [undefined as unknown as ClientConfigExtension], 'client config extension at index 0 is undefined'],
  ];
  for (const [name, extensions, expectedMessage] of cases) {
    const err = t.throws(
      () => loadClientConnectConfig({ configSource: dataSource('[profile.default]'), overrideEnvVars: {}, extensions }),
      undefined,
      name
    );
    t.is(err?.message, expectedMessage, name);
  }
});

test('loadClientConnectConfig wraps extension errors with extension name', (t) => {
  const extErr = new Error('bad config');
  const err = t.throws(() =>
    loadClientConnectConfig({
      configSource: dataSource('[profile.default]'),
      overrideEnvVars: {},
      extensions: [
        testExtension('bad', () => {
          throw extErr;
        }),
      ],
    })
  );
  t.is(err?.message, 'client config extension "bad": bad config');
  t.is(err?.cause, extErr);
});

// =============================================================================
// 📚 EXAMPLE EXTENSION
// =============================================================================

/**
 * Example extension that reads an API key from a file, configured like:
 *
 *     [profile.default.ext.api_key_file]
 *     path = "/path/to/api-key"
 *
 * or with the `TEMPORAL_EXT_API_KEY_FILE_PATH` env var, which takes precedence.
 */
class ApiKeyFileExtension implements ClientConfigExtension {
  readonly name = 'api_key_file';

  clientPlugin({ profile, env }: ClientConfigExtensionRequest): ClientConfigExtensionPlugin | undefined {
    let keyPath: string | undefined;
    const raw = profile.ext?.[this.name]?.['path'];
    if (raw !== undefined) {
      if (typeof raw !== 'string') {
        throw new TypeError(`path must be a string, got ${typeof raw}`);
      }
      keyPath = raw;
    }
    keyPath = env?.['TEMPORAL_EXT_API_KEY_FILE_PATH'] ?? keyPath;
    if (keyPath === undefined) {
      return undefined;
    }
    const apiKey = fs.readFileSync(keyPath, 'utf-8').trim();

    // The options may be used with either `Connection` or `NativeConnection`, so handle both. `SimplePlugin` from
    // `@temporalio/plugin` (with the `apiKey` option) could be used instead.
    return {
      name: 'example.ApiKeyFileExtension',
      configureConnection: (options: ConnectionOptions): ConnectionOptions => ({
        ...options,
        apiKey,
        tls: options.tls ?? true,
      }),
      configureNativeConnection: (options: NativeConnectionOptions): NativeConnectionOptions => ({
        ...options,
        apiKey,
        tls: options.tls ?? true,
      }),
    };
  }
}

test('Example extension', (t) => {
  const keyPath = path.join(os.tmpdir(), `temporal-test-api-key-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(keyPath, 'my-api-key\n');
  try {
    const { connectionOptions } = loadClientConnectConfig({
      configSource: dataSource(dedent`
        [profile.default]
        address = "my-address"
        [profile.default.ext.api_key_file]
        path = ${JSON.stringify(keyPath)}
      `),
      configFileStrict: true,
      overrideEnvVars: {},
      extensions: [new ApiKeyFileExtension()],
    });
    t.is(connectionOptions.plugins?.length, 1);
    const plugin = connectionOptions.plugins![0]! as ClientConfigExtensionPlugin;
    t.like(plugin.configureNativeConnection!(connectionOptions), {
      address: 'my-address',
      apiKey: 'my-api-key',
      tls: true,
    });
    t.like(plugin.configureConnection!({ address: 'my-address' }), { apiKey: 'my-api-key', tls: true });

    // Nothing configured
    const { connectionOptions: unconfigured } = loadClientConnectConfig({
      configSource: dataSource('[profile.default]'),
      overrideEnvVars: {},
      extensions: [new ApiKeyFileExtension()],
    });
    t.is(unconfigured.plugins, undefined);

    // Invalid config
    const err = t.throws(() =>
      loadClientConnectConfig({
        configSource: dataSource('[profile.default.ext.api_key_file]\npath = 5'),
        overrideEnvVars: {},
        extensions: [new ApiKeyFileExtension()],
      })
    );
    t.is(err?.message, 'client config extension "api_key_file": path must be a string, got number');
  } finally {
    fs.unlinkSync(keyPath);
  }
});
