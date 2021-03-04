import test from 'ava';
import { Worker } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('run shuts down gracefully', async (t) => {
    const worker = new Worker(__dirname, { shutdownGraceTime: '500ms' });
    t.is(worker.getState(), 'INITIALIZED');
    const p = worker.run('shutdown-test');
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    t.is(worker.getState(), 'STOPPING');
    await p;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run('shutdown-test'), { message: 'Poller was aleady started' });
  });

  test.serial('run throws if not shut down gracefully', async (t) => {
    const worker = new Worker(__dirname, { shutdownGraceTime: '5ms' });
    t.is(worker.getState(), 'INITIALIZED');
    const p = worker.run('shutdown-test');
    t.is(worker.getState(), 'RUNNING');
    (worker as any).shutdown = function () {
      // Pretend we're shutting down
      this.state = 'STOPPING';
    };
    process.emit('SIGINT', 'SIGINT');
    await t.throwsAsync(p, {
      message: 'Timed out waiting while waiting for worker to shutdown gracefully',
    });
    t.is(worker.getState(), 'FAILED');
    await t.throwsAsync(worker.run('shutdown-test'), { message: 'Poller was aleady started' });
  });
}
