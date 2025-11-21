import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { UnexpectedError, Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { throwUnhandledRejection } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker crashes if workflow throws unhandled rejection that cannot be associated with a workflow run', async (t) => {
    // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
    const taskQueue = `unhandled-rejection-crash-${uuid4()}`;
    const worker = await Worker.create({ ...defaultOptions, taskQueue });
    const client = new WorkflowClient();
    const handle = await client.start(throwUnhandledRejection, {
      workflowId: uuid4(),
      taskQueue,
      args: [{ crashWorker: true }],
    });
    try {
      await t.throwsAsync(worker.run(), {
        instanceOf: UnexpectedError,
        message:
          'Workflow Worker Thread exited prematurely: UnhandledRejectionError: ' +
          "Unhandled Promise rejection for unknown Workflow Run id='undefined': " +
          'Error: error to crash the worker',
      });
      t.is(worker.getState(), 'FAILED');
    } finally {
      await handle.terminate();
    }
  });
}
