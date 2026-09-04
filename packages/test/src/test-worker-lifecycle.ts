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
import { msToTs } from '@temporalio/common/lib/time';
import type { LogEntry, NativeConnection } from '@temporalio/worker';
import { DefaultLogger, MetricsBuffer, Runtime } from '@temporalio/worker';
import { UnexpectedError } from '@temporalio/worker/lib/errors';
import { WorkflowLocallyEvictedError } from '@temporalio/worker/lib/workflow/threaded-vm-errors';
import type { WorkflowThreadEvictionEvent } from '@temporalio/worker/lib/workflow/interface';
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
      async destroy() {},
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

test('Worker fails an outstanding activation after local state loss and waits for Core eviction', async (t) => {
  let evictionHandler: ((event: WorkflowThreadEvictionEvent) => void) | undefined;
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
            throw new WorkflowLocallyEvictedError('Workflow state was discarded under heap pressure');
          },
          async getAndResetSinkCalls() {
            return [];
          },
          async dispose() {
            disposeCount++;
          },
        };
      },
      async destroy() {},
      setLifecycleHandlers(handler) {
        evictionHandler = handler;
      },
    }
  );
  const runId = randomUUID();
  const now = msToTs(Date.now());
  const run = worker.run();
  try {
    evictionHandler!({ runIds: [runId], reason: 'heap-pressure' });
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

    t.deepEqual(worker.native.requestedWorkflowEvictions, [runId]);
    t.is(failed.failed?.failure?.applicationFailureInfo?.type, 'WorkflowLocallyEvictedError');
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
      async destroy() {},
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
