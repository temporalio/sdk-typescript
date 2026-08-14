/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 *
 * @module
 */
import { randomUUID } from 'crypto';
import test from 'ava';
import type { LogEntry, NativeConnection } from '@temporalio/worker';
import { DefaultLogger, MetricsBuffer, Runtime } from '@temporalio/worker';
import { isolateFreeWorker, Worker as MockWorker } from './mock-native-worker';

test.serial('Worker.create debug log options are JSON serializable with buffered metrics and connection', async (t) => {
  const logEntries: LogEntry[] = [];
  const logger = new DefaultLogger('DEBUG', (entry) => {
    JSON.stringify(entry.meta);
    logEntries.push(entry);
  });
  const runtime = Runtime.install({
    logger,
    telemetryOptions: {
      metrics: {
        buffer: new MetricsBuffer(),
      },
    },
  });
  const connection = {
    plugins: [],
    referenceHolders: new Set(),
    runtime,
  } as unknown as NativeConnection;

  try {
    await MockWorker.create({
      taskQueue: `json-logger-${randomUUID()}`,
      activities: {
        noop: async () => undefined,
      },
      connection,
    });

    const creatingWorkerLog = logEntries.find((entry) => entry.message === 'Creating worker');
    t.truthy(creatingWorkerLog);
    t.is(creatingWorkerLog?.meta?.options.connection, '<NativeConnection>');
  } finally {
    (connection as any).referenceHolders.clear();
    await Runtime._instance?.shutdown();
  }
});

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
