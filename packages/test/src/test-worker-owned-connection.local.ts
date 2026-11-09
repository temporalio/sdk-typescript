/**
 * Implicit connection ownership requires the default local server: Worker.create() cannot configure
 * the connection it creates internally. Configured connections are covered by the integration suites.
 */
import { DefaultLogger, PromiseCompletionTimeoutError, Runtime } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, test, uniqueTaskQueue, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker closes its implicit connection and shuts down the Runtime', async (t) => {
    let flushCalls = 0;
    Runtime.install({
      logger: Object.assign(new DefaultLogger('ERROR', () => undefined), {
        flush: () => {
          flushCalls++;
        },
      }),
    });
    const worker = await Worker.create({ ...defaultOptions, taskQueue: uniqueTaskQueue(t.title) });
    t.is(worker.getState(), 'INITIALIZED');
    t.not(Runtime._instance, undefined);
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    const flushesBeforeShutdown = flushCalls;
    process.emit('SIGINT', 'SIGINT');
    await new Promise((resolve) => process.nextTick(resolve));
    t.is(worker.getState(), 'DRAINING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
    t.is(Runtime._instance, undefined);
    t.true(flushCalls > flushesBeforeShutdown);
  });

  test.serial(
    'Worker.runUntil closes its implicit connection when the provided promise outlives shutdown',
    async (t) => {
      let flushCalls = 0;
      Runtime.install({
        logger: Object.assign(new DefaultLogger('ERROR', () => undefined), {
          flush: () => {
            flushCalls++;
          },
        }),
      });
      const worker = await Worker.create({ ...defaultOptions, taskQueue: uniqueTaskQueue(t.title) });
      t.not(Runtime._instance, undefined);
      const workerRun = worker.runUntil(
        new Promise(() => {
          // Keep the promise pending so runUntil must time out after Worker shutdown.
        })
      );
      t.is(worker.getState(), 'RUNNING');
      const flushesBeforeShutdown = flushCalls;
      worker.shutdown();
      t.is(worker.getState(), 'DRAINING');
      await t.throwsAsync(workerRun, { instanceOf: PromiseCompletionTimeoutError });
      t.is(worker.getState(), 'STOPPED');
      t.is(Runtime._instance, undefined);
      t.true(flushCalls > flushesBeforeShutdown);
    }
  );
}
