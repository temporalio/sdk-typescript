/**
 * Test the lifecycle of the Core singleton.
 * Tests run serially because Core is a singleton.
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, Core } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import * as workflows from './workflows';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Core tracks registered workers, shuts down and restarts as expected', async (t) => {
    // Create 2 Workers and verify Core keeps running after first Worker deregisteration
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

    // Core is supposed to shutdown after all Workers have deregistered.
    // Core.install() would fail if a Core instance was already registered.
    await Core.install({});

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
  // Core configuration was installed, creating a new Worker after Core shutdown we would fallback
  // to the default configuration (localhost) which is surprising behavior.
  test.serial('Core.instance() remembers installed options after it has been shut down', async (t) => {
    await Core.install({ serverOptions: { workerBinaryId: 'test-id' } });
    {
      const core = await Core.instance();
      t.is(core.options.serverOptions.workerBinaryId, 'test-id');
    }
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: 'q1', // Same as the first Worker created
    });
    const workerDrained = worker.run();
    worker.shutdown();
    await workerDrained;
    {
      const core = await Core.instance();
      t.is(core.options.serverOptions.workerBinaryId, 'test-id');
      await core.shutdown();
    }
  });

  test.serial('Core.instance() throws meaningful error when passed invalid address', async (t) => {
    await t.throwsAsync(Core.install({ serverOptions: { address: ':invalid' } }), {
      instanceOf: TypeError,
      message: 'Invalid serverOptions.address',
    });
  });

  test.serial('Core.instance() throws meaningful error when passed invalid clientCertPair', async (t) => {
    await t.throwsAsync(Core.install({ serverOptions: { tls: { clientCertPair: {} as any } } }), {
      instanceOf: TypeError,
      message: 'Invalid or missing serverOptions.tls.clientCertPair.crt',
    });
  });

  test.serial('Core.instance() throws meaningful error when passed invalid oTelCollectorUrl', async (t) => {
    await t.throwsAsync(Core.install({ telemetryOptions: { oTelCollectorUrl: ':invalid' } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.oTelCollectorUrl',
    });
  });

  test.serial('Core.instance() throws meaningful error when passed invalid prometheusMetricsBindAddress', async (t) => {
    await t.throwsAsync(Core.install({ telemetryOptions: { prometheusMetricsBindAddress: ':invalid' } }), {
      instanceOf: TypeError,
      message: 'Invalid telemetryOptions.prometheusMetricsBindAddress',
    });
  });

  test.serial('Core.instance() throws meaningful error when passed invalid tracingFilter', async (t) => {
    await t.throwsAsync(Core.install({ telemetryOptions: { tracingFilter: 2 as any } }), {
      instanceOf: TypeError,
      message: 'Invalid tracingFilter',
    });
  });
}
