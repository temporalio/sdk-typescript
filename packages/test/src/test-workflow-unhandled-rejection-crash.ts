import { randomUUID } from 'crypto';
import test from 'ava';
import { UnexpectedError, Worker } from '@temporalio/worker';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, isBun } from './helpers';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { throwUnhandledRejection } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker crashes if workflow throws unhandled rejection that cannot be associated with a workflow run', async (t) => {
    // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
    const taskQueue = `unhandled-rejection-crash-${randomUUID()}`;
    const env = await createTestWorkflowEnvironment();
    try {
      const worker = await Worker.create({
        ...defaultOptions,
        connection: env.nativeConnection,
        namespace: env.namespace,
        taskQueue,
      });
      const handle = await env.client.workflow.start(throwUnhandledRejection, {
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
    } finally {
      await env.teardown();
    }
  });
}
