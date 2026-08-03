import test from 'ava';
import { requiresLocalServer, TestWorkflowEnvironment } from '@temporalio/test-helpers';

const namespace = 'envconfig-test';
const localTest = requiresLocalServer('starts a local source server to validate envconfig parsing', test);

localTest('Envconfig factory connects through envconfig', async (t) => {
  const sourceEnv = await TestWorkflowEnvironment.createLocal({ server: { namespace } });
  let env: TestWorkflowEnvironment | undefined;

  try {
    env = await TestWorkflowEnvironment.createFromEnvConfig({
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
    await Promise.all([env?.teardown(), sourceEnv.teardown()]);
  }
});
