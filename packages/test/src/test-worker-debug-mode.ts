import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker works in debugMode', async (t) => {
    // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
    const taskQueue = 'debug-mode';
    const worker = await Worker.create({ ...defaultOptions, taskQueue, debugMode: true });
    const client = new WorkflowClient();
    const result = await worker.runUntil(
      client.execute(successString, {
        workflowId: uuid4(),
        taskQueue,
      })
    );
    t.is(result, 'success');
  });
}
