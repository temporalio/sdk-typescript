/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 *
 * @module
 */
import { Worker } from '@temporalio/worker';
import test from 'ava';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker shuts down gracefully', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
      shutdownGraceTime: '500ms',
      taskQueue: 'shutdown-test',
    });
    t.is(worker.getState(), 'INITIALIZED');
    const p = worker.run();
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    // Shutdown callback is enqueued as a microtask
    await new Promise((resolve) => process.nextTick(resolve));
    t.is(worker.getState(), 'STOPPING');
    await p;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
  });
}

test.serial('Mocked run shuts down gracefully', async (t) => {
  const worker = isolateFreeWorker({
    shutdownGraceTime: '500ms',
    taskQueue: 'shutdown-test',
  });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  process.emit('SIGINT', 'SIGINT');
  await p;
  t.is(worker.getState(), 'STOPPED');
  await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
});

test('Mocked run throws if not shut down gracefully', async (t) => {
  const worker = isolateFreeWorker({
    shutdownGraceTime: '5ms',
    taskQueue: 'shutdown-test',
  });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  // Make sure shutdown never resolves
  worker.native.initiateShutdown = () => new Promise(() => undefined);
  worker.shutdown();
  await t.throwsAsync(p, {
    message: 'Timed out while waiting for worker to shutdown gracefully',
  });
  t.is(worker.getState(), 'FAILED');
  await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
});
