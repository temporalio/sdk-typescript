import { UnexpectedError } from '@temporalio/worker';
import * as activities from './activities';
import { isBun } from './helpers';
import { helpers, makeTestFunction } from './helpers-integration';
import { throwUnhandledRejection } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Worker crashes if workflow throws unhandled rejection that cannot be associated with a workflow run', async (t) => {
  // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities });
  const handle = await startWorkflow(throwUnhandledRejection, {
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
