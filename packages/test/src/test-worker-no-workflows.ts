import { WorkflowClient } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { runActivityInDifferentTaskQueue } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker functions when asked not to run Workflows', async (t) => {
    const { activities } = defaultOptions;
    const workflowlessWorker = await Worker.create({ taskQueue: 'only-activities', activities });
    const normalWorker = await Worker.create({ ...defaultOptions, taskQueue: 'also-workflows' });
    const client = new WorkflowClient();
    const result = await normalWorker.runUntil(
      workflowlessWorker.runUntil(
        client.execute(runActivityInDifferentTaskQueue, {
          args: ['only-activities'],
          taskQueue: 'also-workflows',
          workflowId: uuid4(),
        })
      )
    );
    t.is(result, 'hi');
  });
}
