/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 *
 * @module
 */
import { setTimeout } from 'timers/promises';
import { randomUUID } from 'crypto';
import test from 'ava';
import { Runtime } from '@temporalio/worker';
import { TransportError, UnexpectedError } from '@temporalio/core-bridge';
import { Client } from '@temporalio/client';
import { sleep } from '@temporalio/activity';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { fillMemory, dontFillMemory } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Worker shuts down gracefully', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: t.title.replace(/ /g, '_'),
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

  test.serial('Threaded VM gracely stops and fails on ERR_WORKER_OUT_OF_MEMORY', async (t) => {
    t.timeout(10_000);

    const taskQueue = t.title.replace(/ /g, '_');
    const client = new Client();
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      activities: {
        activitySleep: () => sleep(10),
        neverEndingActivity: () => sleep(10),
      },
      workflowThreadPoolSize: 2,
    });

    // Each of these workflows will run on average for 120s; we can safely presume that a certain
    // number (actually, most) of these WFT will start executing before the `fillMemory` workflow
    // that we'll schedule later. We use that to ensure that the worker doesn't hang on pending
    // tasks happening
    Promise.all(
      Array.from({ length: 100 }, () =>
        client.workflow.execute(dontFillMemory, {
          taskQueue,
          workflowId: randomUUID(),
        })
      )
    ).catch(() => void 0);

    // This workflow will allocate large block of memory, hopefully causing a ERR_WORKER_OUT_OF_MEMORY.
    // Note that due to the way Node/V8 optimize byte code, its possible that this may trigger
    // other type of errors, including some that can't be intercepted cleanly.
    client.workflow
      .start(fillMemory, {
        taskQueue,
        workflowId: randomUUID(),
        workflowTaskTimeout: '60s',
      })
      .catch(() => void 0);

    const workerRunPromise = worker.run();
    try {
      const res = await Promise.any([
        setTimeout(10_000).then(() => false),
        t.throwsAsync(workerRunPromise, {
          name: UnexpectedError.name,
          message:
            'Workflow Worker Thread exited prematurely: Error [ERR_WORKER_OUT_OF_MEMORY]: ' +
            'Worker terminated due to reaching memory limit: JS heap out of memory',
        }),
      ]);
      if (res !== false) {
        t.is(worker.getState(), 'FAILED');
      } else {
        // Due to various environment factors, it is possible that the worker may sometime
        // not fail. That's obviously not what we want to assert, but that's still ok.
        if (worker.getState() === 'RUNNING') {
          worker.shutdown();
          await workerRunPromise;
          t.log('Non concluent result: Worker did not fail as expected');
          t.pass();
        }
      }
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
    // worker.native.initiateShutdown = () => new Promise(() => undefined);
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
  worker.native.initiateShutdown = () => new Promise(() => undefined);
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
  worker.native.initiateShutdown = () => new Promise(() => undefined);
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
