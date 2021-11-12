import test from 'ava';
import { v4 as uuid4 } from 'uuid';
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
    const runAndShutdown = async () => {
      const result = await client.execute(runActivityInDifferentTaskQueue, {
        args: ['only-activities'],
        taskQueue: 'also-workflows',
        workflowId: uuid4(),
      });
      t.is(result, 'hi');
      workflowlessWorker.shutdown();
      normalWorker.shutdown();
    };
    await Promise.all([workflowlessWorker.run(), normalWorker.run(), runAndShutdown()]);
  });
}
