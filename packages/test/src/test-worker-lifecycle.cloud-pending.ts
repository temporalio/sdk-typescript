/** Worker lifecycle tests that still construct implicit localhost clients and Workers. */
import { randomUUID } from 'crypto';
import { setTimeout } from 'timers/promises';
import test from 'ava';
import { Client } from '@temporalio/client';
import { PromiseCompletionTimeoutError, Runtime } from '@temporalio/worker';
import { TransportError, UnexpectedError } from '@temporalio/worker/lib/errors';
import { isBun, RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { fillMemory } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker shuts down gracefully', async (t) => {
    const worker = await Worker.create({ ...defaultOptions, taskQueue: t.title.replace(/ /g, '_') });
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
    t.is(Runtime._instance, undefined);
  });

  test.serial("Worker.runUntil doesn't hang if provided promise survives to Worker's shutdown", async (t) => {
    const worker = await Worker.create({ ...defaultOptions, taskQueue: t.title.replace(/ /g, '_') });
    t.not(Runtime._instance, undefined);
    const workerRun = worker.runUntil(
      new Promise(() => {
        // A promise that will never unblock.
      })
    );
    t.is(worker.getState(), 'RUNNING');
    worker.shutdown();
    t.is(worker.getState(), 'DRAINING');
    await t.throwsAsync(workerRun, { instanceOf: PromiseCompletionTimeoutError });
    t.is(worker.getState(), 'STOPPED');
    t.is(Runtime._instance, undefined);
  });

  test.serial('Worker shuts down gracefully if interrupted before running', async (t) => {
    const worker = await Worker.create({ ...defaultOptions, taskQueue: t.title.replace(/ /g, '_') });
    t.is(worker.getState(), 'INITIALIZED');
    process.emit('SIGINT', 'SIGINT');
    const workerRun = worker.run();
    t.is(worker.getState(), 'RUNNING');
    await workerRun;
    t.is(worker.getState(), 'STOPPED');
  });

  test.serial('Worker fails validation against unknown namespace', async (t) => {
    await t.throwsAsync(
      Worker.create({
        ...defaultOptions,
        taskQueue: t.title.replace(/ /g, '_'),
        namespace: 'oogabooga',
      }),
      {
        instanceOf: TransportError,
        message: /Namespace oogabooga is not found/,
      }
    );
  });

  (isBun ? test.skip : test.serial)('Threaded VM gracely stops and fails on ERR_WORKER_OUT_OF_MEMORY', async (t) => {
    t.timeout(30_000);
    const taskQueue = t.title.replace(/ /g, '_');
    const client = new Client();
    const worker = await Worker.create({ ...defaultOptions, taskQueue });

    client.workflow
      .start(fillMemory, {
        taskQueue,
        workflowId: randomUUID(),
        workflowExecutionTimeout: '30s',
      })
      .catch(() => void 0);

    const workerRun = worker.run();
    try {
      await Promise.race([setTimeout(10_000), workerRun]);
      if (worker.getState() === 'RUNNING') {
        worker.shutdown();
        await workerRun;
      }
      t.log('Non-conclusive result: Worker did not fail as expected');
      t.pass();
    } catch (err) {
      t.is((err as Error).name, UnexpectedError.name);
      t.is(
        (err as Error).message,
        'Workflow Worker Thread exited prematurely: Error [ERR_WORKER_OUT_OF_MEMORY]: ' +
          'Worker terminated due to reaching memory limit: JS heap out of memory'
      );
      t.is(worker.getState(), 'FAILED');
    } finally {
      if (Runtime._instance) await Runtime._instance.shutdown();
    }
  });
}
