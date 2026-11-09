/**
 * Verify that Workers close connections they create themselves, shutting down the Runtime without
 * an explicit connection.close(). test-worker-lifecycle-integration.ts covers supplied connections,
 * which callers must close after Worker shutdown, against both local servers and Cloud.
 * These tests require the default local server because Worker.create() accepts connection settings
 * only through a supplied connection.
 */
import { PromiseCompletionTimeoutError, Runtime } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, test, uniqueTaskQueue, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker closes its implicit connection and shuts down the Runtime', async (t) => {
    const worker = await Worker.create({ ...defaultOptions, taskQueue: uniqueTaskQueue(t.title) });
    t.is(worker.getState(), 'INITIALIZED');
    t.not(Runtime._instance, undefined);
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => process.nextTick(resolve));
    t.is(worker.getState(), 'DRAINING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
    t.is(Runtime._instance, undefined, 'Worker shutdown closes its implicit connection and shuts down the Runtime');
  });

  test.serial(
    'Worker.runUntil closes its implicit connection when the provided promise outlives shutdown',
    async (t) => {
      const worker = await Worker.create({ ...defaultOptions, taskQueue: uniqueTaskQueue(t.title) });
      t.not(Runtime._instance, undefined);
      const workerRun = worker.runUntil(
        new Promise(() => {
          // Keep the promise pending so runUntil must time out after Worker shutdown.
        })
      );
      t.is(worker.getState(), 'RUNNING');
      worker.shutdown();
      t.is(worker.getState(), 'DRAINING');
      await t.throwsAsync(workerRun, { instanceOf: PromiseCompletionTimeoutError });
      t.is(worker.getState(), 'STOPPED');
      t.is(Runtime._instance, undefined, 'runUntil closes the implicit connection and shuts down the Runtime');
    }
  );
}
