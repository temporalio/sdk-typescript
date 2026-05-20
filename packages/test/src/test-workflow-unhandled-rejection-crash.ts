import test from 'ava';
import { randomUUID } from 'node:crypto';
import { UnexpectedError, Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, isBun } from './helpers';
import { throwUnhandledRejection } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker crashes if workflow throws unhandled rejection that cannot be associated with a workflow run', async (t) => {
    // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
    const taskQueue = `unhandled-rejection-crash-${randomUUID()}`;
    const worker = await Worker.create({ ...defaultOptions, taskQueue });
    const client = new WorkflowClient();
    const handle = await client.start(throwUnhandledRejection, {
      workflowId: randomUUID(),
      taskQueue,
      args: [{ crashWorker: true }],
    });
    try {
      await t.throwsAsync(worker.run(), {
        instanceOf: UnexpectedError, // eslint-disable-line @typescript-eslint/no-deprecated
        message:
          `Workflow Worker Thread exited prematurely: ${isBun ? 'Error' : 'UnhandledRejectionError'}: ` +
          "Unhandled Promise rejection for unknown Workflow Run id='undefined': " +
          'Error: error to crash the worker',
      });
      t.is(worker.getState(), 'FAILED');
    } finally {
      await handle.terminate();
    }
  });
}
