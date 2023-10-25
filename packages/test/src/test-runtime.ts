/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import asyncRetry from 'async-retry';
import { Runtime, DefaultLogger, LogEntry, makeTelemetryFilterString } from '@temporalio/worker';
import { Client, WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';

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
  // to the default configuration (localhost) which is surprising behavior.
  test.serial('Runtime.instance() remembers installed options after it has been shut down', async (t) => {
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

  test.serial('Runtime.instance() Core forwarded logs contains metadata', async (t) => {
    const logEntries: LogEntry[] = [];
    const logger = new DefaultLogger('DEBUG', (entry) => logEntries.push(entry));
    Runtime.install({
      logger,
      telemetryOptions: { logging: { forward: {}, filter: makeTelemetryFilterString({ core: 'DEBUG' }) } },
    });
    try {
      {
        const runtime = Runtime.instance();
        t.is(runtime.options.logger, logger);
      }
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
          { maxTimeout: 5000, retries: 50 }
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
      t.is(typeof failingWftEntry.meta?.['subsystem'], 'string');
    } finally {
      await Runtime.instance().shutdown();
    }
  });

  test.serial('Runtime.instance() throws meaningful error when passed invalid metrics.otel.url', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { metrics: { otel: { url: ':invalid' } } } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.metrics.otel.url',
    });
  });

  test.serial('Runtime.instance() throws meaningful error when passed invalid metrics.prometheus.bindAddress', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: ':invalid' } } } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.metrics.prometheus.bindAddress',
    });
  });

  test.serial('Runtime.instance() throws meaningful error when passed invalid telemetryOptions.logging.filter', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { logging: { filter: 2 as any } } }), {
      instanceOf: TypeError,
      message: 'Invalid filter',
    });
  });
}
