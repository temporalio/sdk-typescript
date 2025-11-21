import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import test from 'ava';
import dedent from 'dedent';
import { Connection, Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  ClientConfig,
  ClientConfigProfile,
  ConfigDataSource,
  fromTomlConfig,
  fromTomlProfile,
  loadClientConfig,
  loadClientConfigProfile,
  loadClientConnectConfig,
  toClientOptions,
  toTomlConfig,
  toTomlProfile,
} from '@temporalio/envconfig';
import { toPathAndData } from '@temporalio/envconfig/lib/utils';
import { NativeConnection } from '@temporalio/worker';
import { encode } from '@temporalio/common/lib/encoding';

// Focused TOML fixtures
const TOML_CONFIG_BASE = dedent`
  [profile.default]
  address = "default-address"
  namespace = "default-namespace"

  [profile.custom]
  address = "custom-address"
  namespace = "custom-namespace"
  api_key = "custom-api-key"
  [profile.custom.tls]
  server_name = "custom-server-name"
  [profile.custom.grpc_meta]
  custom-header = "custom-value"
`;

const TOML_CONFIG_STRICT_FAIL = dedent`
  [profile.default]
  address = "default-address"
  unrecognized_field = "should-fail"
`;

const TOML_CONFIG_TLS_DETAILED = dedent`
  [profile.tls_disabled]
  address = "localhost:1234"
  [profile.tls_disabled.tls]
  disabled = true
  server_name = "should-be-ignored"

  [profile.tls_with_certs]
  address = "localhost:5678"
  [profile.tls_with_certs.tls]
  server_name = "custom-server"
  server_ca_cert_data = "ca-pem-data"
  client_cert_data = "client-crt-data"
  client_key_data = "client-key-data"
`;

function withTempFile(content: string, fn: (filepath: string) => void): void {
  const tempDir = os.tmpdir();
  const filepath = path.join(tempDir, `temporal-test-config-${Date.now()}-${Math.random()}.toml`);
  fs.writeFileSync(filepath, content);
  try {
    fn(filepath);
  } finally {
    fs.unlinkSync(filepath);
  }
}

function pathSource(p: string): ConfigDataSource {
  return { path: p };
}
function dataSource(d: Uint8Array | string): ConfigDataSource {
  return { data: typeof d === 'string' ? encode(d) : d };
}

// =============================================================================
// 🔧 PROFILE LOADING
// =============================================================================

test('Load default profile from file', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const profile = loadClientConfigProfile({ configSource: pathSource(filepath) });
    t.is(profile.address, 'default-address');
    t.is(profile.namespace, 'default-namespace');
    t.is(profile.apiKey, undefined);
    t.is(profile.tls, undefined);
    t.is(profile.grpcMeta, undefined);

    const { connectionOptions, namespace } = toClientOptions(profile);
    t.is(connectionOptions.address, 'default-address');
    t.is(namespace, 'default-namespace');
    t.is(connectionOptions.apiKey, undefined);
    t.is(connectionOptions.tls, undefined);
    t.is(connectionOptions.metadata, undefined);
  });
});

test('Load custom profile from file', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const profile = loadClientConfigProfile({ profile: 'custom', configSource: pathSource(filepath) });
    t.is(profile.address, 'custom-address');
    t.is(profile.namespace, 'custom-namespace');
    t.is(profile.apiKey, 'custom-api-key');
    t.truthy(profile.tls);
    t.is(profile.tls?.serverName, 'custom-server-name');
    t.is(profile.grpcMeta?.['custom-header'], 'custom-value');

    const { connectionOptions, namespace } = toClientOptions(profile);
    t.is(connectionOptions.address, 'custom-address');
    t.is(namespace, 'custom-namespace');
    t.is(connectionOptions.apiKey, 'custom-api-key');
    const tls1 = connectionOptions.tls;
    if (tls1 && typeof tls1 === 'object') {
      t.is(tls1.serverNameOverride, 'custom-server-name');
    } else {
      t.fail('expected TLS config object');
    }
    t.is(connectionOptions.metadata?.['custom-header'], 'custom-value');
  });
});

test('Load default profile from data', (t) => {
  const profile = loadClientConfigProfile({ configSource: dataSource(TOML_CONFIG_BASE) });
  t.is(profile.address, 'default-address');
  t.is(profile.namespace, 'default-namespace');
  t.is(profile.tls, undefined);
});

test('Load custom profile from data', (t) => {
  const profile = loadClientConfigProfile({
    profile: 'custom',
    configSource: dataSource(TOML_CONFIG_BASE),
  });
  t.is(profile.address, 'custom-address');
  t.is(profile.namespace, 'custom-namespace');
  t.is(profile.apiKey, 'custom-api-key');
  t.is(profile.tls?.serverName, 'custom-server-name');
});

test('Load profile from data with env overrides', (t) => {
  const env = {
    TEMPORAL_ADDRESS: 'env-address',
    TEMPORAL_NAMESPACE: 'env-namespace',
  };
  const profile = loadClientConfigProfile({
    configSource: dataSource(TOML_CONFIG_BASE),
    overrideEnvVars: env,
  });
  t.is(profile.address, 'env-address');
  t.is(profile.namespace, 'env-namespace');
});

test('Load custom profile with env overrides', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const env = {
      TEMPORAL_ADDRESS: 'env-address',
      TEMPORAL_NAMESPACE: 'env-namespace',
      TEMPORAL_API_KEY: 'env-api-key',
      TEMPORAL_TLS: 'true',
      TEMPORAL_TLS_SERVER_NAME: 'env-server-name',
      TEMPORAL_GRPC_META_CUSTOM_HEADER: 'env-value',
      TEMPORAL_GRPC_META_ANOTHER_HEADER: 'another-value',
    };
    const profile = loadClientConfigProfile({
      profile: 'custom',
      configSource: pathSource(filepath),
      overrideEnvVars: env,
    });
    t.is(profile.address, 'env-address');
    t.is(profile.namespace, 'env-namespace');
    t.is(profile.apiKey, 'env-api-key');
    t.truthy(profile.tls);
    t.is(profile.tls?.serverName, 'env-server-name');
    t.is(profile.grpcMeta?.['custom-header'], 'env-value');
    t.is(profile.grpcMeta?.['another-header'], 'another-value');
  });
});

test('Load profiles with string content', (t) => {
  const stringContent = TOML_CONFIG_BASE;
  const profile = loadClientConfigProfile({ configSource: dataSource(stringContent) });
  t.is(profile.address, 'default-address');
  t.is(profile.namespace, 'default-namespace');

  // Test with custom profile from string
  const profileCustom = loadClientConfigProfile({
    profile: 'custom',
    configSource: dataSource(stringContent),
  });
  t.is(profileCustom.address, 'custom-address');
  t.is(profileCustom.apiKey, 'custom-api-key');
});

test('loadClientConnectConfig works with file path and env overrides', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    // From file
    let cc = loadClientConnectConfig({ configSource: pathSource(filepath) });
    t.is(cc.connectionOptions.address, 'default-address');
    t.is(cc.namespace, 'default-namespace');

    // With env overrides
    cc = loadClientConnectConfig({
      configSource: pathSource(filepath),
      overrideEnvVars: { TEMPORAL_NAMESPACE: 'env-namespace-override' },
    });
    t.is(cc.namespace, 'env-namespace-override');
  });
});

// =============================================================================
// 🌍 ENVIRONMENT VARIABLES
// =============================================================================

test('Load profile with grpc metadata env overrides', (t) => {
  const toml = dedent`
    [profile.default]
    address = "addr"
    [profile.default.grpc_meta]
    original-header = "original-value"
  `;
  const env = {
    TEMPORAL_GRPC_META_NEW_HEADER: 'new-value',
    TEMPORAL_GRPC_META_OVERRIDE_HEADER: 'overridden-value',
  };
  const profile = loadClientConfigProfile({
    configSource: dataSource(toml),
    overrideEnvVars: env,
  });
  t.is(profile.grpcMeta?.['original-header'], 'original-value');
  t.is(profile.grpcMeta?.['new-header'], 'new-value');
  t.is(profile.grpcMeta?.['override-header'], 'overridden-value');
});

test('gRPC metadata normalization from TOML', (t) => {
  const toml = dedent`
    [profile.foo]
    address = "addr"
    [profile.foo.grpc_meta]
    sOme-hEader_key = "some-value"
  `;
  const conf = loadClientConfig({ configSource: dataSource(toml) });
  const prof = conf.profiles['foo'];
  t.truthy(prof);
  t.is(prof.grpcMeta?.['some-header-key'], 'some-value');
});

test('gRPC metadata deletion via empty env value', (t) => {
  const toml = dedent`
    [profile.default]
    address = "addr"
    [profile.default.grpc_meta]
    some-header = "keep"
    remove-me = "to-be-removed"
  `;
  const env = {
    TEMPORAL_GRPC_META_REMOVE_ME: '',
    TEMPORAL_GRPC_META_NEW_HEADER: 'added',
  };
  const prof = loadClientConfigProfile({ configSource: dataSource(toml), overrideEnvVars: env });
  t.is(prof.grpcMeta?.['some-header'], 'keep');
  t.is(prof.grpcMeta?.['new-header'], 'added');
  t.false(Object.prototype.hasOwnProperty.call(prof.grpcMeta, 'remove-me'));
});

test('Load profile with disable env flag', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const env = { TEMPORAL_ADDRESS: 'env-address' };
    const profile = loadClientConfigProfile({
      configSource: pathSource(filepath),
      overrideEnvVars: env,
      disableEnv: true,
    });
    t.is(profile.address, 'default-address');
  });
});

// =============================================================================
// 🎛️ CONTROL FLAGS
// =============================================================================

test('Load profile with disabled file flag', (t) => {
  const env = { TEMPORAL_ADDRESS: 'env-address', TEMPORAL_NAMESPACE: 'env-namespace' };
  const profile = loadClientConfigProfile({
    configSource: pathSource('/non_existent_file.toml'),
    disableFile: true,
    overrideEnvVars: env,
  });
  t.is(profile.address, 'env-address');
  t.is(profile.namespace, 'env-namespace');
});

test('Load profiles without profile-level env overrides', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const env = { TEMPORAL_ADDRESS: 'should-be-ignored' };
    // loadClientConfig doesn't apply env overrides, so we test it loads correctly
    const conf = loadClientConfig({
      configSource: pathSource(filepath),
      overrideEnvVars: env,
    });
    t.is(conf.profiles['default'].address, 'default-address');

    // Test that profile-level loading with disableEnv ignores environment
    const profile = loadClientConfigProfile({
      configSource: pathSource(filepath),
      overrideEnvVars: env,
      disableEnv: true,
    });
    t.is(profile.address, 'default-address');
  });
});

test('Cannot disable both file and env override flags', (t) => {
  const err = t.throws(() =>
    loadClientConfigProfile({
      configSource: pathSource('/non_existent_file.toml'),
      disableFile: true,
      disableEnv: true,
    })
  );
  t.truthy(err);
  t.true(String(err?.message).includes('Cannot disable both'));
});

// =============================================================================
// 📁 CONFIG DISCOVERY
// =============================================================================

test('Load all profiles from file', (t) => {
  const conf = loadClientConfig({ configSource: dataSource(TOML_CONFIG_BASE) });
  t.truthy(conf.profiles['default']);
  t.truthy(conf.profiles['custom']);
  t.is(conf.profiles['default'].address, 'default-address');
  t.is(conf.profiles['custom'].apiKey, 'custom-api-key');
});

test('Load all profiles from data', (t) => {
  const configData = dedent`
    [profile.alpha]
    address = "alpha-address"
    namespace = "alpha-namespace"
    
    [profile.beta]
    address = "beta-address"
    api_key = "beta-key"
  `;
  const conf = loadClientConfig({ configSource: dataSource(configData) });
  t.truthy(conf.profiles['alpha']);
  t.truthy(conf.profiles['beta']);
  t.is(conf.profiles['alpha'].address, 'alpha-address');
  t.is(conf.profiles['beta'].apiKey, 'beta-key');
});

test('Load profiles from non-existent file', (t) => {
  const conf = loadClientConfig({
    configSource: pathSource('/non_existent_file.toml'),
  });
  t.deepEqual(conf.profiles, {});
});

test('Load all profiles with overridden file path', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const conf = loadClientConfig({ overrideEnvVars: { TEMPORAL_CONFIG_FILE: filepath } });
    t.truthy(conf.profiles['default']);
    t.is(conf.profiles['default'].address, 'default-address');
  });
});

test('Default profile not found returns empty profile', (t) => {
  const toml = dedent`
    [profile.existing]
    address = "my-address"
  `;
  const prof = loadClientConfigProfile({ configSource: dataSource(toml) });
  t.is(prof.address, undefined);
  t.is(prof.namespace, undefined);
  t.is(prof.apiKey, undefined);
  t.is(prof.grpcMeta, undefined);
  t.is(prof.tls, undefined);
  t.deepEqual(prof, {});
});

// =============================================================================
// 🔐 TLS CONFIGURATION
// =============================================================================

test('Load profile with api key (enables TLS)', (t) => {
  const toml = dedent`
    [profile.default]
    address = "my-address"
    api_key = "my-api-key"
  `;
  const profile = loadClientConfigProfile({ configSource: dataSource(toml) });
  t.is(profile.tls, undefined);
  t.is(profile.tls?.disabled, undefined);
  const { connectionOptions } = toClientOptions(profile);
  t.true(connectionOptions.tls);
});

test('Load profile with TLS options', (t) => {
  const configSource = dataSource(TOML_CONFIG_TLS_DETAILED);

  const profileDisabled = loadClientConfigProfile({ configSource, profile: 'tls_disabled' });
  t.truthy(profileDisabled.tls);
  t.true(profileDisabled.tls?.disabled);
  t.is(profileDisabled.tls?.serverName, 'should-be-ignored');
  const { connectionOptions: connOptsDisabled } = toClientOptions(profileDisabled);
  t.is(connOptsDisabled.tls, false);

  const profileCerts = loadClientConfigProfile({ configSource, profile: 'tls_with_certs' });
  t.truthy(profileCerts.tls);
  t.is(profileCerts.tls?.serverName, 'custom-server');

  const serverCACert = toPathAndData(profileCerts.tls?.serverCACert);
  t.deepEqual(serverCACert?.data, encode('ca-pem-data'));
  t.is(serverCACert?.path, undefined);

  const clientCert = toPathAndData(profileCerts.tls?.clientCert);
  t.deepEqual(clientCert?.data, encode('client-crt-data'));
  t.is(clientCert?.path, undefined);

  const clientKey = toPathAndData(profileCerts.tls?.clientKey);
  t.deepEqual(clientKey?.data, encode('client-key-data'));
  t.is(clientKey?.path, undefined);

  const { connectionOptions: connOptsCerts } = toClientOptions(profileCerts);
  const tls2 = connOptsCerts.tls;
  if (tls2 && typeof tls2 === 'object') {
    t.is(tls2.serverNameOverride, 'custom-server');
    t.deepEqual(tls2.serverRootCACertificate, encode('ca-pem-data'));
    t.deepEqual(tls2.clientCertPair?.crt, encode('client-crt-data'));
    t.deepEqual(tls2.clientCertPair?.key, encode('client-key-data'));
  } else {
    t.fail('expected TLS config object');
  }
});

test('Load profile with TLS options as file paths', (t) => {
  withTempFile('ca-pem-data', (caPath) => {
    withTempFile('client-crt-data', (certPath) => {
      withTempFile('client-key-data', (keyPath) => {
        // Normalize paths to use forward slashes for TOML compatibility (Windows uses backslashes)
        const normalizedCaPath = caPath.replace(/\\/g, '/');
        const normalizedCertPath = certPath.replace(/\\/g, '/');
        const normalizedKeyPath = keyPath.replace(/\\/g, '/');

        const tomlConfig = dedent`
          [profile.default]
          address = "localhost:5678"
          [profile.default.tls]
          server_name = "custom-server"
          server_ca_cert_path = "${normalizedCaPath}"
          client_cert_path = "${normalizedCertPath}"
          client_key_path = "${normalizedKeyPath}"
        `;
        const profile = loadClientConfigProfile({ configSource: dataSource(tomlConfig) });
        t.truthy(profile.tls);
        t.is(profile.tls?.serverName, 'custom-server');

        const serverCACert = toPathAndData(profile.tls?.serverCACert);
        t.is(serverCACert?.data, undefined);
        t.deepEqual(serverCACert?.path, normalizedCaPath);

        const clientCert = toPathAndData(profile.tls?.clientCert);
        t.is(clientCert?.data, undefined);
        t.deepEqual(clientCert?.path, normalizedCertPath);

        const clientKey = toPathAndData(profile.tls?.clientKey);
        t.is(clientKey?.data, undefined);
        t.deepEqual(clientKey?.path, normalizedKeyPath);

        const { connectionOptions: connOpts } = toClientOptions(profile);
        const tls3 = connOpts.tls;
        if (tls3 && typeof tls3 === 'object') {
          t.is(tls3.serverNameOverride, 'custom-server');
          t.deepEqual(tls3.serverRootCACertificate, encode('ca-pem-data'));
          t.deepEqual(tls3.clientCertPair?.crt, encode('client-crt-data'));
          t.deepEqual(tls3.clientCertPair?.key, encode('client-key-data'));
        } else {
          t.fail('expected TLS config object');
        }
      });
    });
  });
});

test('Load profile with conflicting cert source fails', (t) => {
  const toml = dedent`
    [profile.default]
    address = "addr"
    [profile.default.tls]
    client_cert_path = "some-path"
    client_cert_data = "some-data"
  `;
  const err = t.throws(() => loadClientConfigProfile({ configSource: dataSource(toml) }));
  t.truthy(err);
  t.true(String(err?.message).includes('Cannot specify both'));
});

test('TLS conflict across sources: path in TOML, data in env should error', (t) => {
  const toml = dedent`
    [profile.default]
    address = "addr"
    [profile.default.tls]
    client_cert_path = "some-path"
  `;
  const env = { TEMPORAL_TLS_CLIENT_CERT_DATA: 'some-data' };
  const err = t.throws(() => loadClientConfigProfile({ configSource: dataSource(toml), overrideEnvVars: env }));
  t.truthy(err);
  t.true(
    String(err?.message)
      .toLowerCase()
      .includes('path')
  );
});

test('TLS conflict across sources: data in TOML, path in env should error', (t) => {
  const toml = dedent`
    [profile.default]
    address = "addr"
    [profile.default.tls]
    client_cert_data = "some-data"
  `;
  const env = { TEMPORAL_TLS_CLIENT_CERT_PATH: 'some-path' };
  const err = t.throws(() => loadClientConfigProfile({ configSource: dataSource(toml), overrideEnvVars: env }));
  t.truthy(err);
  t.true(
    String(err?.message)
      .toLowerCase()
      .includes('data')
  );
});

test('TLS disabled tri-state behavior', (t) => {
  // Test 1: disabled=null (unset) with API key -> TLS enabled
  const tomlNull = dedent`
      [profile.default]
      address = "my-address"
      api_key = "my-api-key"
      [profile.default.tls]
      server_name = "my-server"
    `;
  const profileNull = loadClientConfigProfile({ configSource: dataSource(tomlNull) });
  t.truthy(profileNull.tls);
  t.is(profileNull.tls?.disabled, undefined); // disabled is null (unset)
  const configNull = toClientOptions(profileNull);
  t.truthy(configNull.connectionOptions.tls); // TLS enabled

  // Test 2: disabled=false (explicitly enabled) -> TLS enabled
  const tomlFalse = dedent`
      [profile.default]
      address = "my-address"
      [profile.default.tls]
      disabled = false
      server_name = "my-server"
    `;
  const profileFalse = loadClientConfigProfile({ configSource: dataSource(tomlFalse) });
  t.truthy(profileFalse.tls);
  t.is(profileFalse.tls?.disabled, false); // explicitly disabled=false
  const configFalse = toClientOptions(profileFalse);
  t.truthy(configFalse.connectionOptions.tls); // TLS enabled

  // Test 3: disabled=true (explicitly disabled) -> TLS disabled even with API key
  const tomlTrue = dedent`
      [profile.default]
      address = "my-address"
      api_key = "my-api-key"
      [profile.default.tls]
      disabled = true
      server_name = "should-be-ignored"
    `;
  const profileTrue = loadClientConfigProfile({ configSource: dataSource(tomlTrue) });
  t.truthy(profileTrue.tls);
  t.is(profileTrue.tls?.disabled, true); // explicitly disabled=true
  const configTrue = toClientOptions(profileTrue);
  t.is(configTrue.connectionOptions.tls, false); // TLS explicitly disabled even with API key
});

// =============================================================================
// 🚫 ERROR HANDLING
// =============================================================================

test('Load non-existent profile', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const err = t.throws(() => loadClientConfigProfile({ configSource: pathSource(filepath), profile: 'nonexistent' }));
    t.truthy(err);
    t.true(String(err?.message).includes("Profile 'nonexistent' not found"));
  });
});

test('Load invalid config with strict mode enabled', (t) => {
  const toml = dedent`
    [unrecognized_table]
    foo = "bar"
  `;
  const err = t.throws(() => loadClientConfig({ configSource: dataSource(toml), configFileStrict: true }));
  t.truthy(err);
  t.true(String(err?.message).includes('unrecognized_table'));
});

test('Load invalid profile with strict mode enabled', (t) => {
  withTempFile(TOML_CONFIG_STRICT_FAIL, (filepath) => {
    const err = t.throws(() => loadClientConfigProfile({ configSource: pathSource(filepath), configFileStrict: true }));
    t.truthy(err);
    t.true(String(err?.message).includes('unrecognized_field'));
  });
});

test('Load profiles with malformed TOML', (t) => {
  const err = t.throws(() => loadClientConfig({ configSource: dataSource('this is not valid toml') }));
  t.truthy(err);
  t.true(
    String(err?.message)
      .toLowerCase()
      .includes('toml')
  );
});

// =============================================================================
// 🔄 SERIALIZATION
// =============================================================================

test('Client config profile to/from TOML round-trip', (t) => {
  const profile: ClientConfigProfile = {
    address: 'some-address',
    namespace: 'some-namespace',
    apiKey: 'some-api-key',
    tls: {
      serverName: 'some-server',
      serverCACert: { data: encode('ca') },
      clientCert: { path: '/path/to/client.crt' },
      clientKey: { data: encode('key') },
    },
    grpcMeta: { 'some-header': 'some-value' },
  };
  const tomlProfile = toTomlProfile(profile);
  const back = fromTomlProfile(tomlProfile);
  t.is(back.address, 'some-address');
  t.is(back.namespace, 'some-namespace');
  t.is(back.apiKey, 'some-api-key');
  t.truthy(back.tls);
  t.is(back.tls?.serverName, 'some-server');

  const serverCACert = toPathAndData(back.tls?.serverCACert);
  t.deepEqual(serverCACert?.data, encode('ca'));
  t.is(serverCACert?.path, undefined);

  const clientCert = toPathAndData(back.tls?.clientCert);
  t.is(clientCert?.data, undefined);
  t.deepEqual(clientCert?.path, '/path/to/client.crt');

  const clientKey = toPathAndData(back.tls?.clientKey);
  t.deepEqual(clientKey?.data, encode('key'));
  t.is(clientKey?.path, undefined);

  t.is(back.grpcMeta?.['some-header'], 'some-value');
});

test('Client config to/from TOML round-trip', (t) => {
  const conf: ClientConfig = {
    profiles: {
      default: { address: 'addr', namespace: 'ns', grpcMeta: {} },
      custom: { address: 'addr2', apiKey: 'key2', grpcMeta: { h: 'v' } },
    },
  };
  const tomlConfig = toTomlConfig(conf);
  const back = fromTomlConfig(tomlConfig);
  t.is(back.profiles['default'].address, 'addr');
  t.is(back.profiles['default'].namespace, 'ns');
  t.is(back.profiles['custom'].address, 'addr2');
  t.is(back.profiles['custom'].apiKey, 'key2');
  t.is(back.profiles['custom'].grpcMeta?.['h'], 'v');
});

// =============================================================================
// 🎯 INTEGRATION/E2E
// =============================================================================

test('Create client with default profile, no config', async (t) => {
  // Start a local test server
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;
    // Load config via envconfig
    const { connectionOptions, namespace } = loadClientConnectConfig();
    // Override address with test env address.
    connectionOptions.address = address;

    // Create connection and client with loaded config
    const connection = await Connection.connect(connectionOptions);
    const client = new Client({
      connection,
      namespace,
    });

    // If we got here without throwing, the connection is working
    t.truthy(client);
    t.truthy(client.connection);

    // Clean up
    await connection.close();
  } finally {
    await env.teardown();
  }
});

test('Create client from default profile', async (t) => {
  // Start a local test server
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Create TOML config with test server address
    const toml = dedent`
      [profile.default]
      address = "${address}"
      namespace = "default"
    `;

    // Load config via envconfig
    const { connectionOptions, namespace } = loadClientConnectConfig({
      configSource: dataSource(toml),
    });

    // Verify loaded values
    t.is(connectionOptions.address, address);
    t.is(namespace, 'default');

    // Create connection and client with loaded config
    const connection = await Connection.connect(connectionOptions);
    const client = new Client({
      connection,
      namespace: namespace || 'default',
    });

    // If we got here without throwing, the connection is working
    t.truthy(client);
    t.truthy(client.connection);

    // Clean up
    await connection.close();
  } finally {
    await env.teardown();
  }
});

test('Create client with NativeConnection from default profile', async (t) => {
  // Start a local test server
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Create TOML config with test server address
    const toml = dedent`
        [profile.default]
        address = "${address}"
        namespace = "default"
      `;

    // Load config via envconfig
    const { connectionOptions, namespace } = loadClientConnectConfig({
      configSource: dataSource(toml),
    });

    // Verify loaded values
    t.is(connectionOptions.address, address);
    t.is(namespace, 'default');

    // Create connection and client with loaded config
    const connection = await NativeConnection.connect(connectionOptions);
    const client = new Client({
      connection,
      namespace: namespace || 'default',
    });

    // If we got here without throwing, the connection is working
    t.truthy(client);
    t.truthy(client.connection);

    // Clean up
    await connection.close();
  } finally {
    await env.teardown();
  }
});

test('Create client from custom profile', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Create basic development profile configuration
    const toml = dedent`
      [profile.development]
      address = "${address}"
      namespace = "development-namespace"
    `;

    // Load profile and create connection
    const profile = loadClientConfigProfile({
      profile: 'development',
      configSource: dataSource(toml),
    });

    t.is(profile.address, address);
    t.is(profile.namespace, 'development-namespace');
    t.is(profile.apiKey, undefined);
    t.is(profile.tls, undefined);

    const { connectionOptions, namespace } = toClientOptions(profile);
    const connection = await Connection.connect(connectionOptions);
    const client = new Client({ connection, namespace: namespace || 'default' });

    // Verify the client can perform basic operations
    t.truthy(client);
    t.truthy(client.connection);
    t.is(client.options.namespace, 'development-namespace');

    await connection.close();
  } finally {
    await env.teardown();
  }
});

test('Create client from custom profile with TLS options', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Create production profile with API key (auto-enables TLS but disabled for local test)
    const toml = dedent`
      [profile.production]
      address = "${address}"
      namespace = "production-namespace"
      api_key = "prod-api-key-12345"
      [profile.production.tls]
      disabled = true
    `;

    // Load profile and verify TLS/API key handling
    const profile = loadClientConfigProfile({
      profile: 'production',
      configSource: dataSource(toml),
    });

    t.is(profile.address, address);
    t.is(profile.namespace, 'production-namespace');
    t.is(profile.apiKey, 'prod-api-key-12345');
    t.truthy(profile.tls);
    t.true(!!profile.tls?.disabled);

    const { connectionOptions, namespace } = toClientOptions(profile);

    // Verify API key is present but TLS is disabled for local testing
    t.is(connectionOptions.apiKey, 'prod-api-key-12345');
    t.is(connectionOptions.tls, false); // disabled = true results in tls being false

    const connection = await Connection.connect(connectionOptions);
    const client = new Client({ connection, namespace: namespace || 'default' });

    t.truthy(client);
    t.is(client.options.namespace, 'production-namespace');

    await connection.close();
  } finally {
    await env.teardown();
  }
});

test('Create client from default profile with env overrides', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Base config that will be overridden by environment
    const toml = dedent`
      [profile.default]
      address = "original-address"
      namespace = "original-namespace"
    `;

    // Environment overrides
    const envOverrides = {
      TEMPORAL_ADDRESS: address, // Override with test server address
      TEMPORAL_NAMESPACE: 'env-override-namespace',
      TEMPORAL_GRPC_META_CUSTOM_HEADER: 'env-header-value',
    };

    // Load profile with environment overrides
    const profile = loadClientConfigProfile({
      configSource: dataSource(toml),
      overrideEnvVars: envOverrides,
    });

    // Verify environment variables took precedence
    t.is(profile.address, address);
    t.is(profile.namespace, 'env-override-namespace');
    t.is(profile.grpcMeta?.['custom-header'], 'env-header-value');

    const { connectionOptions, namespace } = toClientOptions(profile);
    const connection = await Connection.connect(connectionOptions);
    const client = new Client({ connection, namespace: namespace || 'default' });

    // Verify client uses overridden values
    t.truthy(client);
    t.is(client.options.namespace, 'env-override-namespace');
    t.is(connectionOptions.metadata?.['custom-header'], 'env-header-value');

    await connection.close();
  } finally {
    await env.teardown();
  }
});

test('Create clients from multi-profile config', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Multi-profile configuration
    const toml = dedent`
      [profile.service-a]
      address = "${address}"
      namespace = "service-a-namespace"
      [profile.service-a.grpc_meta]
      service-name = "service-a"

      [profile.service-b]
      address = "${address}"
      namespace = "service-b-namespace"
      [profile.service-b.grpc_meta]
      service-name = "service-b"
      priority = "high"
    `;

    // Load different profiles and create separate clients
    const profileA = loadClientConfigProfile({
      profile: 'service-a',
      configSource: dataSource(toml),
    });

    const profileB = loadClientConfigProfile({
      profile: 'service-b',
      configSource: dataSource(toml),
    });

    // Verify profiles are distinct
    t.is(profileA.namespace, 'service-a-namespace');
    t.is(profileA.grpcMeta?.['service-name'], 'service-a');
    t.false('priority' in (profileA.grpcMeta ?? {}));

    t.is(profileB.namespace, 'service-b-namespace');
    t.is(profileB.grpcMeta?.['service-name'], 'service-b');
    t.is(profileB.grpcMeta?.['priority'], 'high');

    // Create separate client connections
    const configA = toClientOptions(profileA);
    const configB = toClientOptions(profileB);

    const connectionA = await Connection.connect(configA.connectionOptions);
    const connectionB = await Connection.connect(configB.connectionOptions);

    const clientA = new Client({ connection: connectionA, namespace: configA.namespace || 'default' });
    const clientB = new Client({ connection: connectionB, namespace: configB.namespace || 'default' });

    // Verify both clients work with their respective configurations
    t.truthy(clientA);
    t.truthy(clientB);
    t.is(clientA.options.namespace, 'service-a-namespace');
    t.is(clientB.options.namespace, 'service-b-namespace');

    // Verify metadata is correctly set for each connection
    t.is(configA.connectionOptions.metadata?.['service-name'], 'service-a');
    t.is(configB.connectionOptions.metadata?.['service-name'], 'service-b');
    t.is(configB.connectionOptions.metadata?.['priority'], 'high');

    await connectionA.close();
    await connectionB.close();
  } finally {
    await env.teardown();
  }
});

test('Comprehensive E2E validation test', (t) => {
  // Test comprehensive end-to-end configuration loading with all features
  const tomlContent = dedent`
    [profile.production]
    address = "prod.temporal.com:443"
    namespace = "production-ns"
    api_key = "prod-api-key"

    [profile.production.tls]
    server_name = "prod.temporal.com"
    server_ca_cert_data = "prod-ca-cert"

    [profile.production.grpc_meta]
    authorization = "Bearer prod-token"
    "x-custom-header" = "prod-value"
  `;

  const envOverrides = {
    TEMPORAL_GRPC_META_X_ENVIRONMENT: 'production',
    TEMPORAL_TLS_SERVER_NAME: 'override.temporal.com',
  };

  const { connectionOptions, namespace } = loadClientConnectConfig({
    profile: 'production',
    configSource: dataSource(tomlContent),
    overrideEnvVars: envOverrides,
  });

  // Validate all configuration aspects
  t.is(connectionOptions.address, 'prod.temporal.com:443');
  t.is(namespace, 'production-ns');
  t.is(connectionOptions.apiKey, 'prod-api-key');

  // TLS configuration (API key should auto-enable TLS)
  t.truthy(connectionOptions.tls);
  const tls = connectionOptions.tls;
  if (tls && typeof tls === 'object') {
    t.is(tls.serverNameOverride, 'override.temporal.com'); // Env override
    t.deepEqual(tls.serverRootCACertificate, encode('prod-ca-cert'));
  } else {
    t.fail('expected TLS config object');
  }

  // gRPC metadata with normalization and env overrides
  t.truthy(connectionOptions.metadata);
  const metadata = connectionOptions.metadata!;
  t.is(metadata['authorization'], 'Bearer prod-token');
  t.is(metadata['x-custom-header'], 'prod-value');
  t.is(metadata['x-environment'], 'production'); // From env
});
