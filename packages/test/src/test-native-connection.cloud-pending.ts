/** Native connection lifecycle tests that still construct implicit localhost connections. */
import test from 'ava';
import { IllegalStateError, NativeConnection } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test('NativeConnection.close() throws when called a second time', async (t) => {
    const connection = await NativeConnection.connect();
    await connection.close();
    await t.throwsAsync(() => connection.close(), {
      instanceOf: IllegalStateError,
      message: 'Client already closed',
    });
  });

  test('NativeConnection.close() throws if being used by a Worker and succeeds if it has been shutdown', async (t) => {
    const connection = await NativeConnection.connect();
    const worker = await Worker.create({
      connection,
      taskQueue: 'default',
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
}
