import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import test from 'ava';
import dedent from 'dedent';
import { ClientConfig, ClientConfigProfile, ClientConfigTLS, type DataSource } from '@temporalio/client/lib/envconfig';
import { Connection, Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';

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

function pathSource(p: string): DataSource {
  return { path: p };
}
function dataSource(d: Buffer | string): DataSource {
  return { data: typeof d === 'string' ? Buffer.from(d) : d };
}

// Load default profile from file
test('ClientConfigProfile loads the default profile from a file', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const profile = ClientConfigProfile.load({ configSource: pathSource(filepath) });
    t.is(profile.address, 'default-address');
    t.is(profile.namespace, 'default-namespace');
    t.is(profile.apiKey, undefined);
    t.is(profile.tls, undefined);
    t.deepEqual(profile.grpcMeta, {});

    const { connectionOptions, namespace } = profile.toClientConnectConfig();
    t.is(connectionOptions.address, 'default-address');
    t.is(namespace, 'default-namespace');
    t.is(connectionOptions.apiKey, undefined);
    t.is(connectionOptions.tls, undefined);
    t.deepEqual(connectionOptions.metadata, {});
  });
});

// Load custom profile from file
test('ClientConfigProfile loads a custom profile from a file', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const profile = ClientConfigProfile.load({ profile: 'custom', configSource: pathSource(filepath) });
    t.is(profile.address, 'custom-address');
    t.is(profile.namespace, 'custom-namespace');
    t.is(profile.apiKey, 'custom-api-key');
    t.truthy(profile.tls);
    t.is(profile.tls?.serverName, 'custom-server-name');
    t.is(profile.grpcMeta['custom-header'], 'custom-value');

    const { connectionOptions, namespace } = profile.toClientConnectConfig();
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

// Load profiles from raw TOML data
test('ClientConfigProfile loads profiles from raw TOML data', (t) => {
  const profileDefault = ClientConfigProfile.load({ configSource: dataSource(Buffer.from(TOML_CONFIG_BASE)) });
  t.is(profileDefault.address, 'default-address');
  t.is(profileDefault.namespace, 'default-namespace');
  t.is(profileDefault.tls, undefined);

  const profileCustom = ClientConfigProfile.load({
    profile: 'custom',
    configSource: dataSource(Buffer.from(TOML_CONFIG_BASE)),
  });
  t.is(profileCustom.address, 'custom-address');
  t.is(profileCustom.namespace, 'custom-namespace');
  t.is(profileCustom.apiKey, 'custom-api-key');
  t.is(profileCustom.tls?.serverName, 'custom-server-name');
});

// Environment variable overrides (including gRPC metadata)
test('ClientConfigProfile environment variables override file settings', (t) => {
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
    const profile = ClientConfigProfile.load({
      profile: 'custom',
      configSource: pathSource(filepath),
      overrideEnvVars: env,
    });
    t.is(profile.address, 'env-address');
    t.is(profile.namespace, 'env-namespace');
    t.is(profile.apiKey, 'env-api-key');
    t.truthy(profile.tls);
    t.is(profile.tls?.serverName, 'env-server-name');
    t.is(profile.grpcMeta['custom-header'], 'env-value');
    t.is(profile.grpcMeta['another-header'], 'another-value');
  });
});

// disableEnv prevents env override
test('ClientConfigProfile disableEnv prevents environment variable overrides', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const env = { TEMPORAL_ADDRESS: 'env-address' };
    const profile = ClientConfigProfile.load({
      configSource: pathSource(filepath),
      overrideEnvVars: env,
      disableEnv: true,
    });
    t.is(profile.address, 'default-address');
  });
});

// disableFile supports env-only loading
test('ClientConfigProfile disableFile loads configuration only from environment', (t) => {
  const env = { TEMPORAL_ADDRESS: 'env-address', TEMPORAL_NAMESPACE: 'env-namespace' };
  const profile = ClientConfigProfile.load({
    configSource: pathSource('/non_existent_file.toml'),
    disableFile: true,
    overrideEnvVars: env,
  });
  t.is(profile.address, 'env-address');
  t.is(profile.namespace, 'env-namespace');
});

// Non-existent explicit profile errors
test('ClientConfigProfile raises error for non-existent profile', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const err = t.throws(() =>
      ClientConfigProfile.load({ configSource: pathSource(filepath), profile: 'nonexistent' })
    );
    t.truthy(err);
    t.true(String(err?.message).includes("Profile 'nonexistent' not found"));
  });
});

// Strict mode fails on unrecognized keys
test('ClientConfigProfile strict mode fails on unrecognized keys', (t) => {
  withTempFile(TOML_CONFIG_STRICT_FAIL, (filepath) => {
    const err = t.throws(() =>
      ClientConfigProfile.load({ configSource: pathSource(filepath), configFileStrict: true })
    );
    t.truthy(err);
    t.true(String(err?.message).includes('unrecognized_field'));
  });
});

// toClientConnectConfig throws if address missing
test('ClientConfigProfile toClientConnectConfig throws if address is missing', (t) => {
  const profile = ClientConfigProfile.load({ configSource: dataSource(Buffer.from('[profile.default]')) });
  t.throws(() => profile.toClientConnectConfig(), {
    message: "Configuration profile must contain an 'address' to be used for client connection",
  });
});

// TLS from data + disabled handling
test('ClientConfigProfile parses detailed TLS options', (t) => {
  const configSource = dataSource(Buffer.from(TOML_CONFIG_TLS_DETAILED));

  const profileDisabled = ClientConfigProfile.load({ configSource, profile: 'tls_disabled' });
  t.truthy(profileDisabled.tls);
  t.true(!!profileDisabled.tls?.disabled);
  const { connectionOptions: connOptsDisabled } = profileDisabled.toClientConnectConfig();
  t.is(connOptsDisabled.tls, undefined);

  const profileCerts = ClientConfigProfile.load({ configSource, profile: 'tls_with_certs' });
  t.truthy(profileCerts.tls);
  t.is(profileCerts.tls?.serverName, 'custom-server');
  t.deepEqual(profileCerts.tls?.serverRootCaCert, dataSource('ca-pem-data'));
  t.deepEqual(profileCerts.tls?.clientCert, dataSource('client-crt-data'));
  t.deepEqual(profileCerts.tls?.clientPrivateKey, dataSource('client-key-data'));

  const { connectionOptions: connOptsCerts } = profileCerts.toClientConnectConfig();
  const tls2 = connOptsCerts.tls;
  if (tls2 && typeof tls2 === 'object') {
    t.is(tls2.serverNameOverride, 'custom-server');
    t.deepEqual(tls2.serverRootCACertificate, Buffer.from('ca-pem-data'));
    t.deepEqual(tls2.clientCertPair?.crt, Buffer.from('client-crt-data'));
    t.deepEqual(tls2.clientCertPair?.key, Buffer.from('client-key-data'));
  } else {
    t.fail('expected TLS config object');
  }
});

// TLS from file paths
test('ClientConfigProfile parses TLS options from file paths', (t) => {
  withTempFile('ca-pem-data', (caPath) => {
    withTempFile('client-crt-data', (certPath) => {
      withTempFile('client-key-data', (keyPath) => {
        const tomlConfig = dedent`
          [profile.default]
          address = "localhost:5678"
          [profile.default.tls]
          server_name = "custom-server"
          server_ca_cert_path = "${caPath}"
          client_cert_path = "${certPath}"
          client_key_path = "${keyPath}"
        `;
        const profile = ClientConfigProfile.load({ configSource: dataSource(Buffer.from(tomlConfig)) });
        t.truthy(profile.tls);
        t.is(profile.tls?.serverName, 'custom-server');
        t.deepEqual(profile.tls?.serverRootCaCert, { path: caPath });
        t.deepEqual(profile.tls?.clientCert, { path: certPath });
        t.deepEqual(profile.tls?.clientPrivateKey, { path: keyPath });

        const { connectionOptions: connOpts } = profile.toClientConnectConfig();
        const tls3 = connOpts.tls;
        if (tls3 && typeof tls3 === 'object') {
          t.is(tls3.serverNameOverride, 'custom-server');
          t.deepEqual(tls3.serverRootCACertificate, Buffer.from('ca-pem-data'));
          t.deepEqual(tls3.clientCertPair?.crt, Buffer.from('client-crt-data'));
          t.deepEqual(tls3.clientCertPair?.key, Buffer.from('client-key-data'));
        } else {
          t.fail('expected TLS config object');
        }
      });
    });
  });
});

// API key auto-enables TLS
test('API key presence auto-enables TLS', (t) => {
  const toml = dedent`
    [profile.default]
    address = "my-address"
    api_key = "my-api-key"
  `;
  const profile = ClientConfigProfile.load({ configSource: dataSource(Buffer.from(toml)) });
  t.truthy(profile.tls);
  t.false(!!profile.tls?.disabled);
  const { connectionOptions } = profile.toClientConnectConfig();
  t.truthy(connectionOptions.tls);
});

// Load all profiles via ClientConfig.load
test('ClientConfig.load loads multiple profiles and maps correctly', (t) => {
  const conf = ClientConfig.load({ configSource: dataSource(Buffer.from(TOML_CONFIG_BASE)) });
  t.truthy(conf.profiles['default']);
  t.truthy(conf.profiles['custom']);
  t.is(conf.profiles['default'].address, 'default-address');
  t.is(conf.profiles['custom'].apiKey, 'custom-api-key');
});

// gRPC metadata: normalization from TOML and deletion via env

test('gRPC metadata normalization from TOML', (t) => {
  const toml = dedent`
    [profile.foo]
    address = "addr"
    [profile.foo.grpc_meta]
    sOme-hEader_key = "some-value"
  `;
  const conf = ClientConfig.load({ configSource: dataSource(Buffer.from(toml)) });
  const prof = conf.profiles['foo'];
  t.truthy(prof);
  t.is(prof.grpcMeta['some-header-key'], 'some-value');
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
  const prof = ClientConfigProfile.load({ configSource: dataSource(Buffer.from(toml)), overrideEnvVars: env });
  t.is(prof.grpcMeta['some-header'], 'keep');
  t.is(prof.grpcMeta['new-header'], 'added');
  t.false(Object.prototype.hasOwnProperty.call(prof.grpcMeta, 'remove-me'));
});

// Config discovery and disabling

test('ClientConfig.load discovers config via TEMPORAL_CONFIG_FILE', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const conf = ClientConfig.load({ overrideEnvVars: { TEMPORAL_CONFIG_FILE: filepath } });
    t.truthy(conf.profiles['default']);
    t.is(conf.profiles['default'].address, 'default-address');
  });
});

test('ClientConfig.load with disable_file ignores discovery and returns empty', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    const conf = ClientConfig.load({ disableFile: true, overrideEnvVars: { TEMPORAL_CONFIG_FILE: filepath } });
    t.deepEqual(conf.profiles, {});
  });
});

// Profile existence semantics

test('Default profile not found returns empty profile', (t) => {
  const toml = dedent`
    [profile.existing]
    address = "my-address"
  `;
  const prof = ClientConfigProfile.load({ configSource: dataSource(Buffer.from(toml)) });
  t.is(prof.address, undefined);
  t.is(prof.namespace, undefined);
  t.is(prof.apiKey, undefined);
  t.deepEqual(prof.grpcMeta, {});
  t.is(prof.tls, undefined);
});

// TLS conflict cases

test('TLS conflict in TOML: both path and data should error', (t) => {
  const toml = dedent`
    [profile.default]
    address = "addr"
    [profile.default.tls]
    client_cert_path = "some-path"
    client_cert_data = "some-data"
  `;
  const err = t.throws(() => ClientConfigProfile.load({ configSource: dataSource(Buffer.from(toml)) }));
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
  const err = t.throws(() =>
    ClientConfigProfile.load({ configSource: dataSource(Buffer.from(toml)), overrideEnvVars: env })
  );
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
  const err = t.throws(() =>
    ClientConfigProfile.load({ configSource: dataSource(Buffer.from(toml)), overrideEnvVars: env })
  );
  t.truthy(err);
  t.true(
    String(err?.message)
      .toLowerCase()
      .includes('data')
  );
});

// Strictness: unrecognized table

test('ClientConfig.load strict mode fails on unrecognized table', (t) => {
  const toml = dedent`
    [unrecognized_table]
    foo = "bar"
  `;
  const err = t.throws(() =>
    ClientConfig.load({ configSource: dataSource(Buffer.from(toml)), configFileStrict: true })
  );
  t.truthy(err);
  t.true(String(err?.message).includes('unrecognized_table'));
});

// JSON roundtrips

test('ClientConfigProfile toJSON/fromJSON roundtrip', (t) => {
  const profile = new ClientConfigProfile({
    address: 'some-address',
    namespace: 'some-namespace',
    apiKey: 'some-api-key',
    tls: new ClientConfigTLS({
      serverName: 'some-server',
      serverRootCaCert: { data: Buffer.from('ca') },
      clientCert: { path: '/path/to/client.crt' },
      clientPrivateKey: { data: Buffer.from('key') },
    }),
    grpcMeta: { 'some-header': 'some-value' },
  });
  const json = profile.toJSON();
  const back = ClientConfigProfile.fromJSON(json);
  t.is(back.address, 'some-address');
  t.is(back.namespace, 'some-namespace');
  t.is(back.apiKey, 'some-api-key');
  t.truthy(back.tls);
  t.is(back.tls?.serverName, 'some-server');
  t.deepEqual(back.tls?.serverRootCaCert, { data: 'ca' });
  t.deepEqual(back.tls?.clientCert, { path: '/path/to/client.crt' });
  t.deepEqual(back.tls?.clientPrivateKey, { data: 'key' });
  t.is(back.grpcMeta['some-header'], 'some-value');
});

test('ClientConfig toJSON/fromJSON roundtrip', (t) => {
  const conf = new ClientConfig({
    default: new ClientConfigProfile({ address: 'addr', namespace: 'ns' }),
    custom: new ClientConfigProfile({ address: 'addr2', apiKey: 'key2', grpcMeta: { h: 'v' } }),
  } as any);
  const json = conf.toJSON();
  const back = ClientConfig.fromJSON(json);
  t.is(back.profiles['default'].address, 'addr');
  t.is(back.profiles['default'].namespace, 'ns');
  t.is(back.profiles['custom'].address, 'addr2');
  t.is(back.profiles['custom'].apiKey, 'key2');
  t.is(back.profiles['custom'].grpcMeta['h'], 'v');
});

// Convenience API

test('ClientConfig.loadClientConnectConfig works with file path and env overrides', (t) => {
  withTempFile(TOML_CONFIG_BASE, (filepath) => {
    // From file
    let cc = ClientConfig.loadClientConnectConfig({ configSource: pathSource(filepath) });
    t.is(cc.connectionOptions.address, 'default-address');
    t.is(cc.namespace, 'default-namespace');

    // With env overrides
    cc = ClientConfig.loadClientConnectConfig({
      configSource: pathSource(filepath),
      overrideEnvVars: { TEMPORAL_NAMESPACE: 'env-namespace-override' },
    });
    t.is(cc.namespace, 'env-namespace-override');
  });
});

// Malformed TOML for ClientConfig.load

test('ClientConfig.load raises error for malformed TOML', (t) => {
  const err = t.throws(() => ClientConfig.load({ configSource: dataSource(Buffer.from('this is not valid toml')) }));
  t.truthy(err);
  t.true(
    String(err?.message)
      .toLowerCase()
      .includes('toml')
  );
});

// E2E test: Load config and create client connection

test('ClientConfig.loadClientConnectConfig creates working client connection', async (t) => {
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
    const { connectionOptions, namespace } = ClientConfig.loadClientConnectConfig({
      configSource: dataSource(Buffer.from(toml)),
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

test('ClientConfigProfile with TLS can create client connection', async (t) => {
  // Start a local test server
  const env = await TestWorkflowEnvironment.createLocal();

  try {
    const { address } = env.connection.options;

    // Create TOML config with TLS disabled (local test server doesn't use TLS)
    const toml = dedent`
      [profile.default]
      address = "${address}"
      namespace = "default"
      [profile.default.tls]
      disabled = true
    `;

    // Load config via profile
    const profile = ClientConfigProfile.load({
      configSource: dataSource(Buffer.from(toml)),
    });

    const { connectionOptions, namespace } = profile.toClientConnectConfig();

    // Create connection and client
    const connection = await Connection.connect(connectionOptions);
    const client = new Client({
      connection,
      namespace: namespace || 'default',
    });

    // Verify connection works
    t.truthy(client);
    t.is(connectionOptions.tls, undefined); // disabled TLS results in undefined

    // Clean up
    await connection.close();
  } finally {
    await env.teardown();
  }
});
