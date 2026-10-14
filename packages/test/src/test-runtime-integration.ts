/**
 * Runtime integration tests. Tests run serially because Runtime is a singleton.
 *
 * These tests deliberately avoid a shared test environment, whose connections would keep the Runtime
 * alive: each Worker owns its connection, so the Runtime shuts down once the last Worker stops.
 */
import { randomUUID } from 'crypto';
import asyncRetry from 'async-retry';
import type { ExecutionContext } from 'ava';
import { Client, Connection, WorkflowClient } from '@temporalio/client';
import type { LogEntry, WorkerOptions } from '@temporalio/worker';
import { DefaultLogger, makeTelemetryFilterString, NativeConnection, Runtime } from '@temporalio/worker';
import {
  createWorkerWithOwnConnection,
  ownedConnectionConfig,
  RUN_INTEGRATION_TESTS,
  test,
  uniqueTaskQueue,
  Worker,
} from './helpers';
import { createTestWorkflowBundle } from './helpers-integration';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';
import { log5Times } from './workflows/runtime';

const { namespace, connectionOptions } = ownedConnectionConfig();

function createWorker(options: Partial<WorkerOptions> & Pick<WorkerOptions, 'taskQueue'>) {
  return createWorkerWithOwnConnection({ ...defaultOptions, ...options });
}

/**
 * Connect a client that is not tracked by the Runtime, closed when the test ends.
 */
async function connectClient(t: ExecutionContext): Promise<Connection> {
  const connection = await Connection.connect(connectionOptions);
  t.teardown(() => connection.close());
  return connection;
}

if (RUN_INTEGRATION_TESTS) {
  test.serial('Runtime tracks registered workers, shuts down and restarts as expected', async (t) => {
    const taskQueue1 = uniqueTaskQueue(`${t.title} 1`);
    const taskQueue2 = uniqueTaskQueue(`${t.title} 2`);
    const worker1 = await createWorker({ taskQueue: taskQueue1 });
    const worker2 = await createWorker({ taskQueue: taskQueue2 });
    const worker1Drained = worker1.run();
    const worker2Drained = worker2.run();
    worker1.shutdown();
    await worker1Drained;

    const client = new WorkflowClient({ connection: await connectClient(t), namespace });
    await client.execute(workflows.sleeper, { taskQueue: taskQueue2, workflowId: randomUUID(), args: [1] });
    worker2.shutdown();
    await worker2Drained;

    const worker3 = await createWorker({ taskQueue: taskQueue1 });
    const worker3Drained = worker3.run();
    await client.execute('sleeper', { taskQueue: taskQueue1, workflowId: randomUUID(), args: [1] });
    worker3.shutdown();
    await worker3Drained;
    t.pass();
  });

  test.serial('Runtime.install() remembers installed options after it has been shut down', async (t) => {
    const logger = new DefaultLogger('DEBUG');
    Runtime.install({ logger });
    {
      const runtime = Runtime.instance();
      t.is(runtime.options.logger, logger);
    }

    const worker = await createWorker({ taskQueue: uniqueTaskQueue(t.title) });
    const workerDrained = worker.run();
    worker.shutdown();
    await workerDrained;

    {
      const runtime = Runtime.instance();
      t.is(runtime.options.logger, logger);
      await runtime.shutdown();
    }
  });

  test.serial('Runtime.install() Core forwarded logs contains metadata', async (t) => {
    const logEntries: LogEntry[] = [];
    const logger = new DefaultLogger('DEBUG', (entry) => logEntries.push(entry));
    Runtime.install({
      logger,
      telemetryOptions: { logging: { forward: {}, filter: makeTelemetryFilterString({ core: 'DEBUG' }) } },
    });
    try {
      const taskQueue = uniqueTaskQueue(t.title);
      const client = new Client({ connection: await connectClient(t), namespace });
      await client.workflow.start('not-existant', { taskQueue, workflowId: randomUUID() });
      const worker = await createWorker({ taskQueue });
      await worker.runUntil(() =>
        asyncRetry(
          () => {
            if (!logEntries.some((x) => x.message === 'Failing workflow task'))
              throw new Error('Waiting for failing workflow task');
          },
          { maxTimeout: 200, minTimeout: 20, retries: 40 }
        )
      );

      const initWorkerEntry = logEntries.filter((x) => x.message === 'Initializing worker')?.[0];
      t.true(initWorkerEntry !== undefined);
      t.is(initWorkerEntry.meta?.['taskQueue'], taskQueue);

      const failingWftEntry = logEntries.filter((x) => x.message === 'Failing workflow task')?.[0];
      t.true(failingWftEntry !== undefined);
      t.is(failingWftEntry.meta?.['taskQueue'], taskQueue);
      t.is(typeof failingWftEntry.meta?.['completion'], 'string');
      t.is(typeof failingWftEntry.meta?.['failure'], 'string');
      t.is(typeof failingWftEntry.meta?.['runId'], 'string');
      t.is(typeof failingWftEntry.meta?.['workflowId'], 'string');
      t.is(typeof failingWftEntry.meta?.['sdkComponent'], 'string');
    } finally {
      await Runtime.instance().shutdown();
    }
  });

  test.serial(`NativeLogCollector: Buffered logs are periodically flushed even if Core isn't flushing`, async (t) => {
    const logEntries: LogEntry[] = [];
    const runtime = Runtime.install({
      logger: new DefaultLogger('DEBUG', (entry) => logEntries.push(entry)),
      telemetryOptions: {
        logging: { forward: {}, filter: { core: 'ERROR', other: 'ERROR' } },
      },
    });
    const bufferedLogger = runtime.logger;
    const connection = await NativeConnection.connect(connectionOptions);

    try {
      const taskQueue = `runtime-native-log-collector-preriodically-flushed-${randomUUID()}`;
      const worker = await Worker.create({
        ...defaultOptions,
        connection,
        namespace,
        taskQueue,
        workflowBundle: await createTestWorkflowBundle({ workflowsPath: require.resolve('./workflows/runtime') }),
      });

      const client = new Client({ connection: await connectClient(t), namespace });
      await worker.runUntil(async () => {
        await client.workflow.execute(log5Times, { taskQueue, workflowId: randomUUID() });
      });
      t.true(logEntries.some((x) => x.message.startsWith('workflow log ')));

      bufferedLogger.info('final log');
      t.false(logEntries.some((x) => x.message.startsWith('final log')));
    } finally {
      await connection.close();
      await runtime.shutdown();
    }

    t.is(logEntries.filter((x) => x.message.startsWith('workflow log ')).length, 5);
    t.is(logEntries.filter((x) => x.message.startsWith('final log')).length, 1);
  });
}
