import { randomUUID } from 'crypto';
import test from 'ava';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker works in debugMode', async (t) => {
    // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
    const taskQueue = 'debug-mode';
    const worker = await Worker.create({ ...defaultOptions, taskQueue, debugMode: true });
    const client = new WorkflowClient();
    const result = await worker.runUntil(
      client.execute(successString, {
        workflowId: randomUUID(),
        taskQueue,
      })
    );
    t.is(result, 'success');
  });
}
