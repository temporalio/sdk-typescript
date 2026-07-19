import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTestWorkflowEnvironment } from './helpers-integration';

const namespace = 'envconfig-test';

test.serial('Shared integration harness connects through envconfig', async (t) => {
  const originalGate = process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
  const sourceEnv = await TestWorkflowEnvironment.createLocal({ server: { namespace } });
  let env: TestWorkflowEnvironment | undefined;

  try {
    process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = 'true';
    env = await createTestWorkflowEnvironment(undefined, {
      configSource: {
        data: `[profile.default]
address = "${sourceEnv.address}"
namespace = "${namespace}"
api_key = "envconfig-api-key"

[profile.default.tls]
disabled = true

[profile.default.grpc_meta]
"test-header" = "envconfig-test"
`,
      },
      disableEnv: true,
    });

    t.is(env.address, sourceEnv.address);
    t.is(env.namespace, namespace);
    t.is(env.connectionOptions.apiKey, 'envconfig-api-key');
    t.is(env.connectionOptions.metadata?.['test-header'], 'envconfig-test');
    t.is(env.connectionOptions.tls, false);
  } finally {
    if (originalGate === undefined) {
      delete process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
    } else {
      process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = originalGate;
    }
    await Promise.all([env?.teardown(), sourceEnv.teardown()]);
  }
});
