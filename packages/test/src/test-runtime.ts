/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Runtime, DefaultLogger } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
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

  test.serial('Runtime.instance() throws meaningful error when passed invalid tracing.otel.url', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { tracing: { otel: { url: ':invalid' } } } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.tracing.otel.url',
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
