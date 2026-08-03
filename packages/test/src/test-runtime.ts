/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import { randomUUID } from 'crypto';
import asyncRetry from 'async-retry';
import type { LogEntry } from '@temporalio/worker';
import { Runtime, DefaultLogger, makeTelemetryFilterString } from '@temporalio/worker';
import * as wf from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';
import { RUN_INTEGRATION_TESTS, Worker, test } from './helpers';
import { createTestWorkflowBundle, createTestWorkflowEnvironment } from './helpers-integration';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Runtime can be created and disposed', async (t) => {
    await Runtime.instance().shutdown();
    t.pass();
  });

  test.serial('Runtime tracks registered workers, shuts down and restarts as expected', async (t) => {
    const env = await createTestWorkflowEnvironment();
    // Create 2 Workers and verify Runtime keeps running after first Worker deregisteration
    try {
      const worker1 = await Worker.create({
        ...defaultOptions,
        taskQueue: 'q1',
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const worker2 = await Worker.create({
        ...defaultOptions,
        taskQueue: 'q2',
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const worker1Drained = worker1.run();
      const worker2Drained = worker2.run();
      worker1.shutdown();
      await worker1Drained;
      // Run a simple workflow
      await env.client.workflow.execute(workflows.sleeper, { taskQueue: 'q2', workflowId: randomUUID(), args: [1] });
      worker2.shutdown();
      await worker2Drained;

      const worker3 = await Worker.create({
        ...defaultOptions,
        taskQueue: 'q1',
        connection: env.nativeConnection,
        namespace: env.namespace,
      }); // Same as the first Worker created
      const worker3Drained = worker3.run();
      // Run a simple workflow
      await env.client.workflow.execute('sleeper', { taskQueue: 'q1', workflowId: randomUUID(), args: [1] });
      worker3.shutdown();
      await worker3Drained;
      // No exceptions, test passes, Runtime is implicitly shut down
      t.pass();
    } finally {
      await env.teardown();
    }
  });

  // Stopping and starting Workers is probably not a common pattern but if we don't remember what
  // Runtime configuration was installed, creating a new Worker after Runtime shutdown we would fallback
  // to the default configuration (127.0.0.1) which is surprising behavior.
  test.serial('Runtime.install() remembers installed options after it has been shut down', async (t) => {
    const env = await createTestWorkflowEnvironment();
    const logger = new DefaultLogger('DEBUG');
    Runtime.install({ logger });
    {
      const runtime = Runtime.instance();
      t.is(runtime.options.logger, logger);
    }
    try {
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'q1',
        connection: env.nativeConnection,
        namespace: env.namespace,
      }); // Same as the first Worker created
      const workerDrained = worker.run();
      worker.shutdown();
      await workerDrained;
      {
        const runtime = Runtime.instance();
        t.is(runtime.options.logger, logger);
        await runtime.shutdown();
      }
    } finally {
      await env.teardown();
    }
  });

  test.serial('Runtime.install() Core forwarded logs contains metadata', async (t) => {
    const env = await createTestWorkflowEnvironment();
    const logEntries: LogEntry[] = [];
    const logger = new DefaultLogger('DEBUG', (entry) => logEntries.push(entry));
    Runtime.install({
      logger,
      telemetryOptions: { logging: { forward: {}, filter: makeTelemetryFilterString({ core: 'DEBUG' }) } },
    });
    try {
      await env.client.workflow.start('not-existant', { taskQueue: 'q1', workflowId: randomUUID() });
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'q1',
        connection: env.nativeConnection,
        namespace: env.namespace,
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
      await env.teardown();
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

    const env = await createTestWorkflowEnvironment();
    // Hold on to a connection to prevent implicit shutdown of the runtime before we print 'final log'
    const connection = env.nativeConnection;

    try {
      const taskQueue = `runtime-native-log-collector-preriodically-flushed-${randomUUID()}`;
      const worker = await Worker.create({
        ...defaultOptions,
        connection,
        taskQueue,
        workflowBundle: await createTestWorkflowBundle({ workflowsPath: __filename }),
      });

      await worker.runUntil(async () => {
        await env.client.workflow.execute(log5Times, { taskQueue, workflowId: randomUUID() });
      });
      t.true(logEntries.some((x) => x.message.startsWith('workflow log ')));

      // This one will get buffered
      bufferedLogger.info('final log');
      t.false(logEntries.some((x) => x.message.startsWith('final log')));
    } finally {
      await runtime.shutdown();
      await env.teardown();
    }

    // Assert all log messages have been flushed
    t.is(logEntries.filter((x) => x.message.startsWith('workflow log ')).length, 5);
    t.is(logEntries.filter((x) => x.message.startsWith('final log')).length, 1);
  });
}

export async function log5Times(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    wf.log.info(`workflow log ${i}`);
    await wf.sleep(1);
  }
}
