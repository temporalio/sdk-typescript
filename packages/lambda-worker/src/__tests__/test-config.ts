import test from 'ava';
import { loadLambdaClientConnectConfig } from '../config';

const TOML = '[profile.default]\naddress = "localhost:7233"\n';

// Read from the process env by the AWS Secrets Manager extension, so cleared for these tests
const PROCESS_ENV_VARS = ['AWS_LAMBDA_FUNCTION_NAME', 'PARAMETERS_SECRETS_EXTENSION_HTTP_PORT', 'SECRETS_MANAGER_TTL'];
const prevEnv = Object.fromEntries(PROCESS_ENV_VARS.map((k) => [k, process.env[k]]));

test.before(() => {
  for (const k of PROCESS_ENV_VARS) delete process.env[k];
});

test.after.always(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('AWS Secrets Manager plugin is added when secret IDs are configured', (t) => {
  const config = loadLambdaClientConnectConfig({
    configSource: { data: TOML },
    overrideEnvVars: { TEMPORAL_EXT_AWS_SECRETS_MANAGER_API_KEY_ID: 'temporal/api-key' },
  });
  t.deepEqual(
    config.connectionOptions.plugins?.map((p) => p.name),
    ['@temporalio/aws-secrets-manager']
  );
});

test('no plugin is added without secret IDs', (t) => {
  const config = loadLambdaClientConnectConfig({ configSource: { data: TOML }, overrideEnvVars: {} });
  t.is(config.connectionOptions.plugins, undefined);
});
