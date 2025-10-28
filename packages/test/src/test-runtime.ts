/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import { v4 as uuid4 } from 'uuid';
import asyncRetry from 'async-retry';
import { Runtime, DefaultLogger, LogEntry, makeTelemetryFilterString, NativeConnection } from '@temporalio/worker';
import { Client, WorkflowClient } from '@temporalio/client';
import * as wf from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';
import { RUN_INTEGRATION_TESTS, Worker, test } from './helpers';
import { createTestWorkflowBundle } from './helpers-integration';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Runtime can be created and disposed', async (t) => {
    await Runtime.instance().shutdown();
    t.pass();
  });

  test.serial('Runtime tracks registered workers, shuts down and restarts as expected', async (t) => {
    // Create 2 Workers and verify Runtime keeps running after first Worker deregisteration
    const worker1 = await Worker.create({
      ...defaultOptions,
      taskQueue: 'q1',
    });
    const worker2 = await Worker.create({
      ...defaultOptions,
      taskQueue: 'q2',
    });
    const worker1Drained = worker1.run();
    const worker2Drained = worker2.run();
    worker1.shutdown();
    await worker1Drained;
    const client = new WorkflowClient();
    // Run a simple workflow
    await client.execute(workflows.sleeper, { taskQueue: 'q2', workflowId: uuid4(), args: [1] });
    worker2.shutdown();
    await worker2Drained;

    const worker3 = await Worker.create({
      ...defaultOptions,
      taskQueue: 'q1', // Same as the first Worker created
    });
    const worker3Drained = worker3.run();
    // Run a simple workflow
    await client.execute('sleeper', { taskQueue: 'q1', workflowId: uuid4(), args: [1] });
    worker3.shutdown();
    await worker3Drained;
    // No exceptions, test passes, Runtime is implicitly shut down
    t.pass();
  });

  // Stopping and starting Workers is probably not a common pattern but if we don't remember what
  // Runtime configuration was installed, creating a new Worker after Runtime shutdown we would fallback
  // to the default configuration (127.0.0.1) which is surprising behavior.
  test.serial('Runtime.install() remembers installed options after it has been shut down', async (t) => {
    const logger = new DefaultLogger('DEBUG');
    Runtime.install({ logger });
    {
      const runtime = Runtime.instance();
      t.is(runtime.options.logger, logger);
    }
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: 'q1', // Same as the first Worker created
    });
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
      await new Client().workflow.start('not-existant', { taskQueue: 'q1', workflowId: uuid4() });
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'q1',
      });
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
      t.is(initWorkerEntry.meta?.['taskQueue'], 'q1');

      const failingWftEntry = logEntries.filter((x) => x.message === 'Failing workflow task')?.[0];
      t.true(failingWftEntry !== undefined);
      t.is(failingWftEntry.meta?.['taskQueue'], 'q1');
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
        // Sets native logger to ERROR level, so that it never flushes
        logging: { forward: {}, filter: { core: 'ERROR', other: 'ERROR' } },
      },
    });
    const bufferedLogger = runtime.logger;

    // Hold on to a connection to prevent implicit shutdown of the runtime before we print 'final log'
    const connection = await NativeConnection.connect();

    try {
      const taskQueue = `runtime-native-log-collector-preriodically-flushed-${uuid4()}`;
      const worker = await Worker.create({
        ...defaultOptions,
        connection,
        taskQueue,
        workflowBundle: await createTestWorkflowBundle({ workflowsPath: __filename }),
      });

      await worker.runUntil(async () => {
        await new Client().workflow.execute(log5Times, { taskQueue, workflowId: uuid4() });
      });
      t.true(logEntries.some((x) => x.message.startsWith('workflow log ')));

      // This one will get buffered
      bufferedLogger.info('final log');
      t.false(logEntries.some((x) => x.message.startsWith('final log')));
    } finally {
      await connection.close();
      await runtime.shutdown();
    }

    // Assert all log messages have been flushed
    t.is(logEntries.filter((x) => x.message.startsWith('workflow log ')).length, 5);
    t.is(logEntries.filter((x) => x.message.startsWith('final log')).length, 1);
  });

  test.serial('Runtime handle heartbeat duration default', async (t) => {
    const runtime = Runtime.install({});
    const SIXTY_SECONDS = 60 * 1000;
    t.true(runtime.options.runtimeOptions.workerHeartbeatIntervalMillis === SIXTY_SECONDS);
    await runtime.shutdown();
  });

  test.serial('Runtime handle heartbeat duration null', async (t) => {
    const runtime = Runtime.install({
      workerHeartbeatInterval: null,
    });
    t.true(runtime.options.runtimeOptions.workerHeartbeatIntervalMillis === null);
    await runtime.shutdown();
  });

  test.serial('Runtime handle heartbeat duration undefined', async (t) => {
    const runtime = Runtime.install({
      workerHeartbeatInterval: 13 * 1000,
    });
    t.true(runtime.options.runtimeOptions.workerHeartbeatIntervalMillis === 13 * 1000);
    await runtime.shutdown();
  });
}

export async function log5Times(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    wf.log.info(`workflow log ${i}`);
    await wf.sleep(1);
  }
}
