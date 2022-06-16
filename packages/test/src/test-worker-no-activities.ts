import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker functions when asked not to run Activities', async (t) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { activities, taskQueue, ...rest } = defaultOptions;
    const worker = await Worker.create({ taskQueue: 'only-workflows', ...rest });
    const client = new WorkflowClient();
    const result = await worker.runUntil(
      client.execute(successString, {
        workflowId: uuid4(),
        taskQueue: 'only-workflows',
      })
    );
    t.is(result, 'success');
  });
}
