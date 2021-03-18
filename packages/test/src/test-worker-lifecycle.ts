/**
 * Test the various states of a worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import test from 'ava';
import { Worker } from '@temporalio/worker';
import { sleep } from '@temporalio/worker/lib/utils';
import { Worker as MockableWorker, MockNativeWorker } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('run shuts down gracefully', async (t) => {
    const worker = new Worker(__dirname, { shutdownGraceTime: '500ms', activitiesPath: null });
    t.is(worker.getState(), 'INITIALIZED');
    const p = worker.run('shutdown-test');
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    t.is(worker.getState(), 'STOPPING');
    await p;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run('shutdown-test'), { message: 'Poller was aleady started' });
  });
}

test.serial('Mocked run shuts down gracefully', async (t) => {
  const nativeWorker = new MockNativeWorker();
  const worker = new MockableWorker(nativeWorker, __dirname, { shutdownGraceTime: '500ms', activitiesPath: null });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run('shutdown-test');
  t.is(worker.getState(), 'RUNNING');
  process.emit('SIGINT', 'SIGINT');
  t.is(worker.getState(), 'STOPPING');
  await p;
  t.is(worker.getState(), 'STOPPED');
  await t.throwsAsync(worker.run('shutdown-test'), { message: 'Poller was aleady started' });
});

test.serial('Mocked run throws if not shut down gracefully', async (t) => {
  const nativeWorker = new MockNativeWorker();
  const worker = new MockableWorker(nativeWorker, __dirname, { shutdownGraceTime: '5ms', activitiesPath: null });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run('shutdown-test');
  t.is(worker.getState(), 'RUNNING');
  nativeWorker.shutdown = () => undefined; // Make sure shutdown does not emit core shutdown
  process.emit('SIGINT', 'SIGINT');
  await t.throwsAsync(p, {
    message: 'Timed out waiting while waiting for worker to shutdown gracefully',
  });
  t.is(worker.getState(), 'FAILED');
  await t.throwsAsync(worker.run('shutdown-test'), { message: 'Poller was aleady started' });
});

test('Mocked worker suspends and resumes', async (t) => {
  const nativeWorker = new MockNativeWorker();
  const worker = new MockableWorker(nativeWorker, __dirname, { shutdownGraceTime: '5ms', activitiesPath: null });
  const p = worker.run('suspend-test');
  t.is(worker.getState(), 'RUNNING');
  worker.suspendPolling();
  t.is(worker.getState(), 'SUSPENDED');
  // Worker finishes its polling before suspension
  await nativeWorker.runAndWaitCompletion({ workflow: { runId: 'abc' } });
  const completion = nativeWorker.runAndWaitCompletion({ workflow: { runId: 'abc' } });
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
