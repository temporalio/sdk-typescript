/** Native connection lifecycle tests using connections independent from the fixture-owned connection. */
import { IllegalStateError } from '@temporalio/worker';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('NativeConnection.close() throws when called a second time', async (t) => {
  const { createNativeConnection } = helpers(t);
  const conn = await createNativeConnection();
  await conn.close();
  await t.throwsAsync(() => conn.close(), {
    instanceOf: IllegalStateError,
    message: 'Client already closed',
  });
});

test('NativeConnection.close() throws if being used by a Worker and succeeds if it has been shutdown', async (t) => {
  const { createNativeConnection, createWorker } = helpers(t);
  const connection = await createNativeConnection();
  const worker = await createWorker({
    connection,
    workflowBundle: undefined,
    activities: {
      async noop() {
        // Empty placeholder.
      },
    },
  });
  try {
    await t.throwsAsync(() => connection.close(), {
      instanceOf: IllegalStateError,
      message: 'Cannot close connection while Workers hold a reference to it',
    });
  } finally {
    const workerRun = worker.run();
    worker.shutdown();
    await workerRun;
    await connection.close();
  }
});
