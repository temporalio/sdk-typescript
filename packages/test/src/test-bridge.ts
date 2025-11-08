import { setTimeout } from 'node:timers/promises';
import ms from 'ms';
import test from 'ava';
import { native, errors } from '@temporalio/core-bridge';

// TESTING NOTES
//
// - Tests in this file requires an external Temporal server to be running, because using the ephemeral
//   server support provided by Core SDK would affect the behavior that we're testing here.
// - Some of these tests explicitly use the native bridge, without going through the lang side Runtime/Worker.

test.serial('Can instantiate and shutdown the native runtime', async (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  t.is(typeof runtime, 'object');
  native.runtimeShutdown(runtime);

  // Pass this point, any operation on the runtime should throw

  t.throws(() => native.newClient(runtime, GenericConfigs.client.basic), {
    instanceOf: errors.IllegalStateError,
    message: 'Runtime already closed',
  });

  // Trying to shutdown the runtime a second time should throw
  t.throws(() => native.runtimeShutdown(runtime), {
    instanceOf: errors.IllegalStateError,
    message: 'Runtime already closed',
  });
});

test.serial('Can run multiple runtime concurrently', async (t) => {
  const runtime1 = native.newRuntime(GenericConfigs.runtime.basic);
  const runtime2 = native.newRuntime(GenericConfigs.runtime.basic);
  const runtime3 = native.newRuntime(GenericConfigs.runtime.basic);

  // Order is intentionally random - distinct runtimes are expected to be independent
  const _client2 = await native.newClient(runtime3, GenericConfigs.client.basic);
  const _client1 = await native.newClient(runtime1, GenericConfigs.client.basic);
  const _client3 = await native.newClient(runtime2, GenericConfigs.client.basic);

  native.runtimeShutdown(runtime1);
  native.runtimeShutdown(runtime3);

  await t.throwsAsync(async () => await native.newClient(runtime1, GenericConfigs.client.basic), {
    instanceOf: errors.IllegalStateError,
    message: 'Runtime already closed',
  });

  const _client5 = await native.newClient(runtime2, GenericConfigs.client.basic);

  native.runtimeShutdown(runtime2);

  t.pass();
});

test.serial('Missing/invalid properties in config throws appropriately', async (t) => {
  // required string = undefined ==> missing property
  t.throws(
    () =>
      native.newRuntime({
        ...GenericConfigs.runtime.basic,
        logExporter: {
          type: 'forward',
          // @ts-expect-error 2322
          filter: undefined,
        },
      }),
    {
      instanceOf: TypeError,
      message: "fn runtime_new.args[0].logExporter.forward.filter: Missing property 'filter'",
    }
  );

  // required string = null ==> failed to downcast
  t.throws(
    () =>
      native.newRuntime({
        ...GenericConfigs.runtime.basic,
        logExporter: {
          type: 'forward',
          // @ts-expect-error 2322
          filter: null,
        },
      }),
    {
      instanceOf: TypeError,
      // FIXME: should say "failed to downcast _null_ to string"
      message: 'fn runtime_new.args[0].logExporter.forward.filter: failed to downcast any to string',
    }
  );

  // required string = number ==> failed to downcast
  t.throws(
    () =>
      native.newRuntime({
        ...GenericConfigs.runtime.basic,
        logExporter: {
          type: 'forward',
          // @ts-expect-error 2322
          filter: 1234,
        },
      }),
    {
      instanceOf: TypeError,
      // FIXME: should say "failed to downcast _number_ to string"
      message: 'fn runtime_new.args[0].logExporter.forward.filter: failed to downcast any to string',
    }
  );

  // optional object = undefined ==> missing property
  t.throws(
    () =>
      native.newRuntime({
        ...GenericConfigs.runtime.basic,
        // @ts-expect-error 2322
        metricsExporter: undefined,
      }),
    {
      instanceOf: TypeError,
      message: "fn runtime_new.args[0].metricsExporter: Missing property 'metricsExporter'",
    }
  );
});

test.serial(`get_time_of_day() returns a bigint`, async (t) => {
  const time_1 = native.getTimeOfDay();
  const time_2 = native.getTimeOfDay();
  await setTimeout(100);
  const time_3 = native.getTimeOfDay();

  t.is(typeof time_1, 'bigint');
  t.true(time_1 < time_2);

  // We only care about rough scale, so let's say at least 40ms should have passed, to avoid flakes
  t.true(time_2 + 40_000_000n < time_3);
});

test.serial("Creating Runtime without shutting it down doesn't hang process", (t) => {
  const _runtime = native.newRuntime(GenericConfigs.runtime.basic);
  t.pass();
});

test.serial("Dropping Client without closing doesn't hang process", (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const _client = native.newClient(runtime, GenericConfigs.client.basic);
  t.pass();
});

test.serial("Dropping Worker without shutting it down doesn't hang process", async (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const client = await native.newClient(runtime, GenericConfigs.client.basic);
  const worker = native.newWorker(client, GenericConfigs.worker.basic);
  await native.workerValidate(worker);
  t.pass();
});

// FIXME(JWH): This is causing hangs on shutdown on Windows.
// test.serial("Dropping EphemeralServer without shutting it down doesn't hang process", async (t) => {
//   const runtime = native.newRuntime(GenericConfigs.runtime.basic);
//   const _ephemeralServer = await native.newEphemeralServer(runtime, GenericConfigs.ephemeralServer.basic);
//   t.pass();
// });

test.serial("Stopping Worker after creating another runtime doesn't fail", async (t) => {
  async function expectShutdownError(taskPromise: Promise<Buffer>) {
    await t.throwsAsync(taskPromise, {
      instanceOf: errors.ShutdownError,
    });
  }

  const runtime0 = native.newRuntime(GenericConfigs.runtime.basic);
  const runtime1 = native.newRuntime(GenericConfigs.runtime.basic);

  // Starts Worker 0
  console.log('Starting Worker 0');
  const client0 = await native.newClient(runtime0, GenericConfigs.client.basic);
  const worker0 = native.newWorker(client0, GenericConfigs.worker.basic);
  await native.workerValidate(worker0);

  // Start Worker 1
  console.log('Starting Worker 1');
  const client1 = await native.newClient(runtime1, GenericConfigs.client.basic);
  const worker1 = native.newWorker(client1, GenericConfigs.worker.basic);
  await native.workerValidate(worker1);

  // Start polling on Worker 1 (note reverse order of Worker 0)
  console.log('Starting polling on Worker 1');
  const wftPromise1 = native.workerPollWorkflowActivation(worker1);
  const atPromise1 = native.workerPollActivityTask(worker1);

  // Start polling on Worker 0
  console.log('Starting polling on Worker 0');
  const wftPromise0 = native.workerPollWorkflowActivation(worker0);
  const atPromise0 = native.workerPollActivityTask(worker0);

  // Cleanly shutdown Worker 1
  console.log('Shutting down Worker 1');
  native.workerInitiateShutdown(worker1);
  await expectShutdownError(wftPromise1);
  await expectShutdownError(atPromise1);
  await native.workerFinalizeShutdown(worker1);
  // Leave Client 1 and Runtime 1 alive
  console.log('Leave Client 1 and Runtime 1 alive');

  // Create Runtime 2 and Worker 2, but don't immediately use them
  console.log('Creating Worker 2');
  const runtime2 = native.newRuntime(GenericConfigs.runtime.basic);
  const client2 = await native.newClient(runtime2, GenericConfigs.client.basic);
  const worker2 = native.newWorker(client2, GenericConfigs.worker.basic);

  // Cleanly shutdown Worker 0
  console.log('Shutting down Worker 0');
  native.workerInitiateShutdown(worker0);
  await expectShutdownError(wftPromise0);
  await expectShutdownError(atPromise0);
  await native.workerFinalizeShutdown(worker0);
  native.clientClose(client0);
  native.runtimeShutdown(runtime0);

  // Start yet another runtime, we really won't use it
  console.log("Start yet another runtime, we really won't use it");
  const _runtime3 = native.newRuntime(GenericConfigs.runtime.basic);

  // Start polling on Worker 2, then shut it down cleanly
  console.log('Starting polling on Worker 2');
  await native.workerValidate(worker2);
  const wftPromise2 = native.workerPollWorkflowActivation(worker2); // TODO: failing here
  const atPromise2 = native.workerPollActivityTask(worker2);
  native.workerInitiateShutdown(worker2);
  await expectShutdownError(wftPromise2);
  await expectShutdownError(atPromise2);
  await native.workerFinalizeShutdown(worker2);
  native.clientClose(client2);
  native.runtimeShutdown(runtime2);
  console.log('t.pass()');

  t.pass();
});

// Sample configs ///////////////////////////////////////////////////////////////////////////////////

const GenericConfigs = {
  runtime: {
    basic: {
      logExporter: {
        type: 'console',
        filter: 'INFO',
      },
      telemetry: {
        metricPrefix: 'test',
        attachServiceName: false,
      },
      metricsExporter: null,
    } satisfies native.RuntimeOptions,
  },
  client: {
    basic: {
      targetUrl: 'http://127.0.0.1:7233',
      clientName: 'temporal-typescript-test',
      clientVersion: '1.0.0',
      tls: null,
      httpConnectProxy: null,
      headers: null,
      apiKey: null,
      disableErrorCodeMetricTags: false,
    } satisfies native.ClientOptions,
  },
  worker: {
    basic: {
      taskQueue: 'default',
      identity: 'test-worker',
      buildId: 'test-build-id',
      workerDeploymentOptions: null,
      useVersioning: false,
      namespace: 'default',
      tuner: {
        workflowTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 2,
        },
        activityTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 1,
        },
        localActivityTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 1,
        },
        nexusTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 1,
        },
      },
      nonStickyToStickyPollRatio: 0.5,
      workflowTaskPollerBehavior: {
        type: 'simple-maximum',
        maximum: 2,
      },
      activityTaskPollerBehavior: {
        type: 'autoscaling',
        minimum: 1,
        initial: 5,
        maximum: 100,
      },
      nexusTaskPollerBehavior: {
        type: 'autoscaling',
        minimum: 1,
        initial: 5,
        maximum: 100,
      },
      enableNonLocalActivities: false,
      stickyQueueScheduleToStartTimeout: 1000,
      maxCachedWorkflows: 1000,
      maxHeartbeatThrottleInterval: 1000,
      defaultHeartbeatThrottleInterval: 1000,
      maxTaskQueueActivitiesPerSecond: null,
      maxActivitiesPerSecond: null,
      shutdownGraceTime: 1000,
    } satisfies native.WorkerOptions,
  },
  ephemeralServer: {
    basic: {
      type: 'dev-server',
      exe: {
        type: 'cached-download',
        downloadDir: null,
        version: 'default',
        ttl: ms('1y'),
        sdkName: 'sdk-typescript',
        sdkVersion: '1.0.0',
      },
      ip: '127.0.0.1',
      port: null,
      ui: false,
      uiPort: null,
      namespace: 'default',
      dbFilename: null,
      log: { format: 'text', level: 'warn' },
      extraArgs: [],
    } satisfies native.EphemeralServerConfig,
  },
} as const;
