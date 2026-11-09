/**
 * Test the various states of a Worker.
 * Most tests use a mocked core. Tests run serially because they share the Runtime
 * singleton and may emit signals to the process.
 *
 * @module
 */
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import { mock } from 'node:test';
import test from 'ava';
import Long from 'long';
import {
  IllegalStateError,
  createPayloadValidationError,
  defaultPayloadConverter,
  type PayloadCodec,
} from '@temporalio/common';
import { msToTs } from '@temporalio/common/time';
import type { LogEntry, NativeConnection } from '@temporalio/worker';
import { DefaultLogger, LogTimestamp, MetricsBuffer, Runtime, UnexpectedError, Worker } from '@temporalio/worker';
import { isolateFreeWorker, Worker as MockWorker } from './mock-native-worker';

test.afterEach.always(async () => {
  try {
    await Runtime._instance?.shutdown();
  } finally {
    delete Runtime._instance;
    Runtime.defaultOptions = {};
    delete Runtime.instantiator;
  }
});

test.serial('Worker.create releases its runtime when bundling fails', async (t) => {
  await t.throwsAsync(
    Worker.create({
      taskQueue: 'failed-worker-preparation',
      workflowBundle: { codePath: `${__dirname}/nonexistent-workflow-bundle.js` },
    }),
    { code: 'ENOENT' }
  );
  t.is(Runtime._instance, undefined);
});

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
  }
});

test.serial('Mocked run shuts down gracefully', async (t) => {
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
});

test.serial('Logger failures do not interrupt Worker state transitions', async (t) => {
  const stderr: string[] = [];
  const writeSync = mock.method(fs, 'writeSync', (fd: number, data: string) => {
    if (fd === 2) stderr.push(data);
    return data.length;
  });
  t.teardown(() => writeSync.mock.restore());

  const runtime = Runtime.install({
    logger: new DefaultLogger('TRACE', () => {
      throw new Error('logging failed');
    }),
  });

  // WARN and ERROR messages that the application logger failed to emit fall back to stderr.
  // A malformed timestamp must not prevent that.
  runtime.logger.info('fallback-info');
  runtime.logger.warn('fallback-warn', { [LogTimestamp]: 123, key: 'value' });
  t.is(stderr.length, 1);
  t.regex(stderr[0], /\[WARN\] fallback-warn .*key/);

  const worker = isolateFreeWorker({ taskQueue: t.title.replace(/ /g, '_') });
  t.is(worker.getState(), 'INITIALIZED');
  const run = worker.run();
  t.is(worker.getState(), 'RUNNING');
  worker.shutdown();
  await t.notThrowsAsync(run);
  t.is(worker.getState(), 'STOPPED');
});

test.serial('Worker retains a failed Workflow until Core eviction', async (t) => {
  const invalidPayload = defaultPayloadConverter.toPayload('invalid-payload');
  const codec: PayloadCodec = {
    async encode(payloads) {
      if (payloads.some((payload) => defaultPayloadConverter.fromPayload(payload) === 'invalid-payload')) {
        throw createPayloadValidationError({ field: 'nexus-input' });
      }
      return payloads;
    },
    async decode(payloads) {
      return payloads;
    },
  };
  let disposeCount = 0;
  const worker = isolateFreeWorker(
    {
      taskQueue: t.title.replace(/ /g, '_'),
      activities: {},
      dataConverter: { payloadCodecs: [codec] },
    },
    {
      async createWorkflow() {
        return {
          async activate() {
            return {
              successful: {
                commands: [{ scheduleNexusOperation: { seq: 1, input: invalidPayload } }],
              },
            };
          },
          async getAndResetSinkCalls() {
            return [];
          },
          async dispose() {
            disposeCount++;
          },
        };
      },
      async destroy() {
        // Nothing to destroy
      },
    }
  );
  const runId = randomUUID();
  const now = msToTs(Date.now());
  const run = worker.run();
  try {
    const failed = await worker.native.runWorkflowActivation({
      runId,
      timestamp: now,
      jobs: [
        {
          initializeWorkflow: {
            workflowId: 'workflow-id',
            workflowType: 'test',
            randomnessSeed: Long.ONE,
            firstExecutionRunId: runId,
            originalExecutionRunId: runId,
            attempt: 1,
            startTime: now,
            workflowTaskTimeout: msToTs('10 seconds'),
          },
        },
      ],
    });

    t.is(failed.failed?.failure?.applicationFailureInfo?.type, 'PayloadValidationError');
    t.is(disposeCount, 0);

    const evicted = await worker.native.runWorkflowActivation({
      runId,
      jobs: [{ removeFromCache: {} }],
    });

    t.truthy(evicted.successful);
    t.is(disposeCount, 1);
  } finally {
    worker.shutdown();
    await run;
  }
});

test.serial('Worker closes an evicted Workflow when disposal fails', async (t) => {
  const disposeFailure = new Error('dispose failed');
  let disposeCount = 0;
  const worker = isolateFreeWorker(
    {
      taskQueue: t.title.replace(/ /g, '_'),
      activities: {},
    },
    {
      async createWorkflow() {
        return {
          async activate() {
            return { successful: {} };
          },
          async getAndResetSinkCalls() {
            return [];
          },
          async dispose() {
            disposeCount++;
            throw disposeFailure;
          },
        };
      },
      async destroy() {
        // Nothing to destroy
      },
    }
  );
  const runId = randomUUID();
  const now = msToTs(Date.now());
  const run = worker.run();
  try {
    const started = await worker.native.runWorkflowActivation({
      runId,
      timestamp: now,
      jobs: [
        {
          initializeWorkflow: {
            workflowId: 'workflow-id',
            workflowType: 'test',
            randomnessSeed: Long.ONE,
            firstExecutionRunId: runId,
            originalExecutionRunId: runId,
            attempt: 1,
            startTime: now,
            workflowTaskTimeout: msToTs('10 seconds'),
          },
        },
      ],
    });

    t.truthy(started.successful);
    t.is(worker.getStatus().numCachedWorkflows, 1);

    const evicted = await worker.native.runWorkflowActivation({
      runId,
      jobs: [{ removeFromCache: {} }],
    });

    t.truthy(evicted.successful);
    t.is(disposeCount, 1);
    t.is(worker.getStatus().numCachedWorkflows, 0);

    const error = await t.throwsAsync(run);
    if (error === undefined) return;
    // oxlint-disable-next-line typescript/no-deprecated -- Assert the internal worker error type.
    t.assert(error instanceof UnexpectedError);
    t.is(error.cause, disposeFailure);
    t.is(worker.getState(), 'FAILED');
  } finally {
    if (worker.getState() === 'RUNNING') worker.shutdown();
    await run.catch(() => undefined);
  }
});

test.serial('Mocked run shuts down gracefully if interrupted before running', async (t) => {
  const worker = isolateFreeWorker({
    taskQueue: t.title.replace(/ /g, '_'),
  });
  t.is(worker.getState(), 'INITIALIZED');
  process.emit('SIGINT', 'SIGINT');
  const p = worker.run();
  t.is(worker.getState(), 'RUNNING');
  await p;
  t.is(worker.getState(), 'STOPPED');
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

test.serial('Worker.run preserves primary failure when finalization fails', async (t) => {
  const primaryError = new Error('primary worker failure');
  const cleanupError = new IllegalStateError('Worker still in use: Expected 1 reference, but got 2');

  const worker = isolateFreeWorker({
    taskQueue: t.title.replace(/ /g, '_'),
    activities: {},
  });

  worker.native.pollWorkflowActivation = async () => {
    throw primaryError;
  };
  worker.native.finalizeShutdown = async () => {
    throw cleanupError;
  };

  const err = await t.throwsAsync(worker.run());
  t.is(err, primaryError);
  t.is(worker.getState(), 'FAILED');
});

test.serial('Worker.run propagates finalization failure on otherwise successful run', async (t) => {
  const cleanupError = new IllegalStateError('Cleanup failure on stop');
  const worker = isolateFreeWorker({
    taskQueue: t.title.replace(/ /g, '_'),
    activities: {},
  });

  worker.native.finalizeShutdown = async () => {
    throw cleanupError;
  };

  const runPromise = worker.run();
  t.is(worker.getState(), 'RUNNING');
  worker.shutdown();

  const err = await t.throwsAsync(runPromise);
  t.is(err, cleanupError);
});
