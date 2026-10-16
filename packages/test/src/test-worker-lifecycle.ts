/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 *
 * @module
 */
import { randomUUID } from 'crypto';
import test from 'ava';
import Long from 'long';
import { createPayloadValidationError, defaultPayloadConverter, type PayloadCodec } from '@temporalio/common';
import { msToTs } from '@temporalio/common/time';
import type { LogEntry, NativeConnection } from '@temporalio/worker';
import { DefaultLogger, MetricsBuffer, Runtime, UnexpectedError } from '@temporalio/worker';
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

test('Worker retains a failed Workflow until Core eviction', async (t) => {
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

test('Worker closes an evicted Workflow when disposal fails', async (t) => {
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
    t.assert(error instanceof UnexpectedError);
    t.is(error.cause, disposeFailure);
    t.is(worker.getState(), 'FAILED');
  } finally {
    if (worker.getState() === 'RUNNING') worker.shutdown();
    await run.catch(() => undefined);
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

test.serial('Runtime preserves flushable logger across shutdown and re-instantiation', async (t) => {
  let closed = false;
  let flushCount = 0;
  const messages: string[] = [];

  const logger = Object.assign(
    new DefaultLogger('INFO', (entry) => {
      if (closed) {
        throw new Error(`Attempted to log to closed logger: ${entry.message}`);
      }
      messages.push(entry.message);
    }),
    {
      flush: () => {
        flushCount++;
      },
      close: () => {
        closed = true;
      },
    }
  );

  try {
    await Runtime._instance?.shutdown();
    Runtime.install({ logger });

    const runtime1 = Runtime.instance();
    t.is(runtime1.logger, logger);

    // Simulate an active native reference holding the runtime alive
    const fakeRef = {} as any;
    (runtime1 as any).backRefs.add(fakeRef);
    await (runtime1 as any).shutdownIfIdle();
    t.is(Runtime._instance, runtime1);
    t.false(closed);

    // Release the reference; runtime automatically shuts down on idle
    (runtime1 as any).backRefs.delete(fakeRef);
    await (runtime1 as any).shutdownIfIdle();
    t.is(Runtime._instance, undefined);

    // Assert: Runtime shutdown MUST NOT close user-provided logger, but MUST flush it
    t.false(closed, 'user logger must not be closed on runtime shutdown');
    t.true(flushCount > 0, 'user logger should be flushed on shutdown');

    // Re-instantiate runtime using remembered defaultOptions (as NativeConnection.connect does)
    const runtime2 = Runtime.instance();
    t.is(runtime2.logger, logger, 'runtime reinstantiation should reuse the configured logger');

    // Logger must remain valid and operational
    t.notThrows(() => {
      runtime2.logger.info('message after reinstantiation');
    });
    t.deepEqual(messages, ['message after reinstantiation']);
  } finally {
    await Runtime._instance?.shutdown();
    Runtime.defaultOptions = {};
    delete Runtime.instantiator;
  }
});

test.serial(
  'Runtime preserves flushable logger across shutdown and re-instantiation with log forwarding',
  async (t) => {
    let closed = false;
    let flushCount = 0;
    const messages: string[] = [];

    const logger = Object.assign(
      new DefaultLogger('INFO', (entry) => {
        if (closed) {
          throw new Error(`Attempted to log to closed logger: ${entry.message}`);
        }
        messages.push(entry.message);
      }),
      {
        flush: () => {
          flushCount++;
        },
        close: () => {
          closed = true;
        },
      }
    );

    try {
      await Runtime._instance?.shutdown();
      Runtime.install({
        logger,
        telemetryOptions: {
          logging: {
            forward: { level: 'INFO' },
          },
        },
      });

      const runtime1 = Runtime.instance();
      // When log forwarding is enabled, runtime1.logger wraps the downstream logger
      t.not(runtime1.logger, logger);

      // Simulate an active native reference holding the runtime alive
      const fakeRef = {} as any;
      (runtime1 as any).backRefs.add(fakeRef);
      await (runtime1 as any).shutdownIfIdle();
      t.is(Runtime._instance, runtime1);
      t.false(closed);

      // Release the reference; runtime automatically shuts down on idle
      (runtime1 as any).backRefs.delete(fakeRef);
      await (runtime1 as any).shutdownIfIdle();
      t.is(Runtime._instance, undefined);

      // Assert: Runtime shutdown MUST NOT close downstream user-provided logger, but MUST flush it
      t.false(closed, 'user logger must not be closed on runtime shutdown with log forwarding');
      t.true(flushCount > 0, 'user logger should be flushed on shutdown');

      // Re-instantiate runtime using remembered defaultOptions
      const runtime2 = Runtime.instance();
      t.notThrows(() => {
        runtime2.logger.info('message after reinstantiation with forwarding');
      });

      // Flush to ensure message is forwarded to downstream logger immediately
      runtime2.flushLogs();
      t.true(messages.includes('message after reinstantiation with forwarding'));
      t.false(closed);
    } finally {
      await Runtime._instance?.shutdown();
      Runtime.defaultOptions = {};
      delete Runtime.instantiator;
    }
  }
);

test.serial('Runtime supports repeated shutdown and reinstantiation cycles with flushable logger', async (t) => {
  let closed = false;
  const messages: string[] = [];

  const logger = Object.assign(
    new DefaultLogger('INFO', (entry) => {
      if (closed) {
        throw new Error(`Attempted to log to closed logger: ${entry.message}`);
      }
      messages.push(entry.message);
    }),
    {
      flush: () => undefined,
      close: () => {
        closed = true;
      },
    }
  );

  try {
    await Runtime._instance?.shutdown();
    Runtime.install({ logger });

    for (let cycle = 1; cycle <= 3; cycle++) {
      const runtime = Runtime.instance();
      t.is(runtime.logger, logger);
      runtime.logger.info(`cycle ${cycle} start`);

      const fakeRef = {} as any;
      (runtime as any).backRefs.add(fakeRef);
      (runtime as any).backRefs.delete(fakeRef);
      await (runtime as any).shutdownIfIdle();
      t.is(Runtime._instance, undefined);
      t.false(closed, `logger must not be closed after cycle ${cycle}`);
    }

    const finalRuntime = Runtime.instance();
    finalRuntime.logger.info('final message');
    t.is(messages.length, 4);
    t.is(messages[3], 'final message');
    t.false(closed);
  } finally {
    await Runtime._instance?.shutdown();
    Runtime.defaultOptions = {};
    delete Runtime.instantiator;
  }
});
