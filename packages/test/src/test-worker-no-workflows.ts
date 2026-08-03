import { randomUUID } from 'crypto';
import test from 'ava';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { runActivityInDifferentTaskQueue } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker functions when asked not to run Workflows', async (t) => {
    const env = await createTestWorkflowEnvironment();
    const { activities } = defaultOptions;
    try {
      const workflowlessWorker = await Worker.create({
        taskQueue: 'only-activities',
        activities,
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const normalWorker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'also-workflows',
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const result = await normalWorker.runUntil(
        workflowlessWorker.runUntil(
          env.client.workflow.execute(runActivityInDifferentTaskQueue, {
            args: ['only-activities'],
            taskQueue: 'also-workflows',
            workflowId: randomUUID(),
          })
        )
      );
      t.is(result, 'hi');
    } finally {
      await env.teardown();
    }
  });
}
