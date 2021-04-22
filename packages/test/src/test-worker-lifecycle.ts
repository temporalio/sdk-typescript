/**
 * Test the various states of a worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import test from 'ava';
import { Worker } from '@temporalio/worker';
import { sleep } from '@temporalio/worker/lib/utils';
import { Worker as MockedWorker } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial.skip('run shuts down gracefully', async (t) => {
    const worker = await Worker.create({
      shutdownGraceTime: '500ms',
      taskQueue: 'shutdown-test',
    });
    t.is(worker.getState(), 'INITIALIZED');
    const p = worker.run();
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    t.is(worker.getState(), 'STOPPING');
    await p;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was aleady started' });
  });
}

test.serial('Mocked run shuts down gracefully', async (t) => {
  const worker = new MockedWorker({
    shutdownGraceTime: '500ms',
    taskQueue: 'shutdown-test',
  });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  process.emit('SIGINT', 'SIGINT');
  t.is(worker.getState(), 'STOPPING');
  await p;
  t.is(worker.getState(), 'STOPPED');
  await t.throwsAsync(worker.run(), { message: 'Poller was aleady started' });
});

test.serial('Mocked run throws if not shut down gracefully', async (t) => {
  const worker = new MockedWorker({
    shutdownGraceTime: '5ms',
    taskQueue: 'shutdown-test',
  });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  worker.native.shutdown = () => undefined; // Make sure shutdown does not emit core shutdown
  process.emit('SIGINT', 'SIGINT');
  await t.throwsAsync(p, {
    message: 'Timed out while waiting for worker to shutdown gracefully',
  });
  t.is(worker.getState(), 'FAILED');
  await t.throwsAsync(worker.run(), { message: 'Poller was aleady started' });
});

test('Mocked worker suspends and resumes', async (t) => {
  const worker = new MockedWorker({
    shutdownGraceTime: '5ms',
    taskQueue: 'suspend-test',
  });
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  worker.suspendPolling();
  t.is(worker.getState(), 'SUSPENDED');
  // Worker finishes its polling before suspension
  await worker.native.runWorkflowActivation({ runId: 'abc' });
  const completion = worker.native.runWorkflowActivation({ runId: 'abc' });
  await t.throwsAsync(
    Promise.race([
      sleep(10).then(() => {
        throw new Error('timeout');
      }),
      completion,
    ]),
    { message: 'timeout' }
  );
  t.is(worker.getState(), 'SUSPENDED');
  worker.resumePolling();
  await completion;
  worker.shutdown();
  await p;
});
