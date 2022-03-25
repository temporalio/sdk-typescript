/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Runtime can be started and stopped', async (t) => {
    Runtime.install({});
    await Runtime.instance().shutdown();
    t.pass();
  });

  test.serial('Runtime tracks registered workers, shuts down and restarts as expected', async (t) => {
    Runtime.install({});

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
    const connection = new WorkflowClient();
    // Run a simple workflow
    await connection.execute(workflows.sleeper, { taskQueue: 'q2', workflowId: uuid4(), args: [1] });
    worker2.shutdown();
    await worker2Drained;

    // Runtime is supposed to shutdown after all Workers have deregistered.
    // Runtime.install() would fail if a Runtime instance was already registered.
    Runtime.install({});

    const worker3 = await Worker.create({
      ...defaultOptions,
      taskQueue: 'q1', // Same as the first Worker created
    });
    const worker3Drained = worker3.run();
    // Run a simple workflow
    await connection.execute('sleeper', { taskQueue: 'q1', workflowId: uuid4(), args: [1] });
    worker3.shutdown();
    await worker3Drained;
    // No exceptions, test passes
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

  test.serial('Runtime.instance() throws meaningful error when passed invalid oTelCollectorUrl', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { oTelCollectorUrl: ':invalid' } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.oTelCollectorUrl',
    });
  });

  test.serial('Runtime.instance() throws meaningful error when passed invalid prometheusMetricsBindAddress', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { prometheusMetricsBindAddress: ':invalid' } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.prometheusMetricsBindAddress',
    });
  });

  test.serial('Runtime.instance() throws meaningful error when passed invalid tracingFilter', (t) => {
    t.throws(() => Runtime.install({ telemetryOptions: { tracingFilter: 2 as any } }), {
      instanceOf: TypeError,
      message: 'Invalid tracingFilter',
    });
  });
}
