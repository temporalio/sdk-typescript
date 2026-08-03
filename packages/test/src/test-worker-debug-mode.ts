import { randomUUID } from 'crypto';
import test from 'ava';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker works in debugMode', async (t) => {
    const env = await createTestWorkflowEnvironment();
    // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
    const taskQueue = 'debug-mode';
    try {
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue,
        debugMode: true,
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(successString, {
          workflowId: randomUUID(),
          taskQueue,
        })
      );
      t.is(result, 'success');
    } finally {
      await env.teardown();
    }
  });
}
