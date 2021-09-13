import test from 'ava';
import { Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { runActivityInDifferentTaskQueue } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker functions when asked not to run Workflows', async (t) => {
    const { activities } = defaultOptions;
    const workflowlessWorker = await Worker.create({ taskQueue: 'only-activities', activities });
    const normalWorker = await Worker.create({ ...defaultOptions, taskQueue: 'also-workflows' });
    const client = new WorkflowClient();
    const runner = client.newWorkflowStub(runActivityInDifferentTaskQueue, {
      taskQueue: 'also-workflows',
    });
    const runAndShutdown = async () => {
      const result = await runner.execute('only-activities');
      t.is(result, 'hi');
      workflowlessWorker.shutdown();
      normalWorker.shutdown();
    };
    await Promise.all([workflowlessWorker.run(), normalWorker.run(), runAndShutdown()]);
  });
}
