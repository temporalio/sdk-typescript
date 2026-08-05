import { randomUUID } from 'crypto';
import test from 'ava';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker functions when asked not to run Activities', async (t) => {
    const env = await createTestWorkflowEnvironment();
    const workflowTaskQueue = `only-workflows-${randomUUID()}`;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { activities, taskQueue, ...rest } = defaultOptions;
    try {
      const worker = await Worker.create({
        taskQueue: workflowTaskQueue,
        ...rest,
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(successString, {
          workflowId: randomUUID(),
          taskQueue: workflowTaskQueue,
        })
      );
      t.is(result, 'success');
    } finally {
      await env.teardown();
    }
  });
}
