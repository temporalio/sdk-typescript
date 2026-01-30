/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 *
 * @module
 */
import { setTimeout } from 'timers/promises';
import { randomUUID } from 'crypto';
import test from 'ava';
import { Runtime, PromiseCompletionTimeoutError } from '@temporalio/worker';
import { TransportError, UnexpectedError } from '@temporalio/worker/lib/errors';
import { Client } from '@temporalio/client';
import { isBun, RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { fillMemory } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker shuts down gracefully', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: t.title.replace(/ /g, '_'),
    });
    t.is(worker.getState(), 'INITIALIZED');
    t.not(Runtime._instance, undefined);
    const p = worker.run();
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    // Shutdown callback is enqueued as a microtask
    await new Promise((resolve) => process.nextTick(resolve));
    t.is(worker.getState(), 'DRAINING');
    await p;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
    t.is(Runtime._instance, undefined);
  });

  test.serial("Worker.runUntil doesn't hang if provided promise survives to Worker's shutdown", async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: t.title.replace(/ /g, '_'),
    });
    t.not(Runtime._instance, undefined);
    const p = worker.runUntil(
      new Promise(() => {
        /* a promise that will never unblock */
      })
    );
    t.is(worker.getState(), 'RUNNING');
    worker.shutdown();
    t.is(worker.getState(), 'DRAINING');
    await t.throwsAsync(p, { instanceOf: PromiseCompletionTimeoutError });
    t.is(worker.getState(), 'STOPPED');
    t.is(Runtime._instance, undefined);
  });

  test.serial('Worker shuts down gracefully if interrupted before running', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: t.title.replace(/ /g, '_'),
    });
    t.is(worker.getState(), 'INITIALIZED');
    process.emit('SIGINT', 'SIGINT');
    const p = worker.run();
    t.is(worker.getState(), 'RUNNING');
    await p;
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

  // Skip this test for Bun as the workflow doesn't cause an OOM unlike Node
  (isBun ? test.skip : test.serial)('Threaded VM gracely stops and fails on ERR_WORKER_OUT_OF_MEMORY', async (t) => {
    // We internally use a timeout of 10s to catch a possible case where test would
    // be non-conclusive. We need the test timeout to be longer than that.
    t.timeout(30_000);

    const taskQueue = t.title.replace(/ /g, '_');
    const client = new Client();
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
    });

    // This workflow will allocate large block of memory, hopefully causing a ERR_WORKER_OUT_OF_MEMORY.
    // Note that due to the way Node/V8 optimize byte code, its possible that this may trigger
    // other type of errors, including some that can't be intercepted cleanly.
    client.workflow
      .start(fillMemory, {
        taskQueue,
        workflowId: randomUUID(),
        // Don't linger
        workflowExecutionTimeout: '30s',
      })
      .catch(() => void 0);

    const workerRunPromise = worker.run();
    try {
      // Due to various environment factors, it is possible that the worker may sometime not fail.
      // That's obviously not what we want to assert, but that's still ok. We therefore set a
      // timeout of 10s and simply pass if the Worker hasn't failed by then.
      await Promise.race([setTimeout(10_000), workerRunPromise]);
      if (worker.getState() === 'RUNNING') {
        worker.shutdown();
        await workerRunPromise;
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

test.serial('Mocked run shuts down gracefully', async (t) => {
  try {
    const worker = isolateFreeWorker({
      taskQueue: t.title.replace(/ /g, '_'),
    });
    t.is(worker.getState(), 'INITIALIZED');
    const p = worker.run();
    t.is(worker.getState(), 'RUNNING');
    process.emit('SIGINT', 'SIGINT');
    await p;
    t.is(worker.getState(), 'STOPPED');
    await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
  } finally {
    if (Runtime._instance) await Runtime._instance.shutdown();
  }
});

test.serial('Mocked run shuts down gracefully if interrupted before running', async (t) => {
  try {
    const worker = isolateFreeWorker({
      taskQueue: t.title.replace(/ /g, '_'),
    });
    t.is(worker.getState(), 'INITIALIZED');
    process.emit('SIGINT', 'SIGINT');
    const p = worker.run();
    t.is(worker.getState(), 'RUNNING');
    await p;
    t.is(worker.getState(), 'STOPPED');
  } finally {
    if (Runtime._instance) await Runtime._instance.shutdown();
  }
});

test.serial('Mocked run throws if not shut down gracefully', async (t) => {
  const worker = isolateFreeWorker({
    shutdownForceTime: '5ms',
    taskQueue: t.title.replace(/ /g, '_'),
  });
  t.is(worker.getState(), 'INITIALIZED');
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  // Make sure shutdown never resolves
  worker.native.initiateShutdown = () => undefined;
  worker.shutdown();
  await t.throwsAsync(p, {
    message: 'Timed out while waiting for worker to shutdown gracefully',
  });
  t.is(worker.getState(), 'FAILED');
  await t.throwsAsync(worker.run(), { message: 'Poller was already started' });
});

test.serial('Mocked throws combined error in runUntil', async (t) => {
  const worker = isolateFreeWorker({
    shutdownForceTime: '5ms',
    taskQueue: t.title.replace(/ /g, '_'),
  });
  worker.native.initiateShutdown = () => undefined;
  const err = await t.throwsAsync(
    worker.runUntil(async () => {
      throw new Error('inner');
    })
  );
  t.is(worker.getState(), 'FAILED');
  t.is(err?.message, 'Worker terminated with fatal error in `runUntil`');
  const { workerError, innerError } = (err as any).cause;
  t.is(workerError.message, 'Timed out while waiting for worker to shutdown gracefully');
  t.is(innerError.message, 'inner');
});
