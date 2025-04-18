import { setTimeout } from 'node:timers/promises';
import ms from 'ms';
import test from 'ava';
import { native, errors } from '@temporalio/core-bridge';

// TESTING NOTES
//
// - Tests in this file requires an external Temporal server to be running, because using the ephemeral
//   server support provided by Core SDK would affect the behavior that we're testing here.
// - Tests in this file can't be run in parallel, since the bridge is mostly a singleton.
// - Some of these tests explicitly use the native bridge, without going through the lang side Runtime/Worker.

test('Can instantiate and shutdown the native runtime', async (t) => {
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

test('Can run multiple runtime concurrently', async (t) => {
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

test('Missing/invalid properties in config throws appropriately', async (t) => {
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

test(`get_time_of_day() returns a bigint`, async (t) => {
  const time_1 = await native.getTimeOfDay();
  const time_2 = await native.getTimeOfDay();
  await setTimeout(100);
  const time_3 = await native.getTimeOfDay();

  t.is(typeof time_1, 'bigint');
  t.true(time_1 < time_2);
  t.true(time_2 + 100_000_000n < time_3); // At least 100ms passed
});

test("Creating Runtime without shutting it down doesn't hang process", (t) => {
  const _runtime = native.newRuntime(GenericConfigs.runtime.basic);
  t.pass();
});

test("Dropping Client without closing doesn't hang process", (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const _client = native.newClient(runtime, GenericConfigs.client.basic);
  t.pass();
});

test("Dropping Worker without shutting it down doesn't hang process", async (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const client = await native.newClient(runtime, GenericConfigs.client.basic);
  const worker = native.newWorker(client, GenericConfigs.worker.basic);
  await native.workerValidate(worker);
  t.pass();
});

// FIXME: Not hanging, but server is left running. Should try to kill process on Finalize?
test.skip("Dropping EphemeralServer without shutting it down doesn't hang process", async (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const _ephemeralServer = await native.startEphemeralServer(runtime, GenericConfigs.ephemeralServer.basic);
  t.pass();
});

// Sample configs ///////////////////////////////////////////////////////////////////////////////////

const GenericConfigs = {
  runtime: {
    basic: {
      logExporter: {
        type: 'console',
        filter: 'ERROR',
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
      url: 'http://127.0.0.1:7233',
      sdkVersion: '1.0.0',
      tls: null,
      proxy: null,
      metadata: null,
      apiKey: null,
      disableErrorCodeMetricTags: false,
    } satisfies native.ClientOptions,
  },
  worker: {
    basic: {
      taskQueue: 'default',
      identity: 'test-worker',
      buildId: 'test-build-id',
      useVersioning: false,
      namespace: 'default',
      tuner: {
        workflowTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 1,
        },
        activityTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 1,
        },
        localActivityTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 1,
        },
      },
      nonStickyToStickyPollRatio: 0.5,
      maxConcurrentWorkflowTaskPolls: 1,
      maxConcurrentActivityTaskPolls: 1,
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
      executable: {
        type: 'cached-download',
        downloadDir: null,
        version: 'default',
        ttl: ms('1y'),
        sdkVersion: '1.0.0',
      },
      ip: '127.0.0.1',
      port: null,
      ui: false,
      uiPort: null,
      namespace: 'default',
      dbFilename: null,
      log: { format: 'json', level: 'info' },
      extraArgs: [],
    } satisfies native.EphemeralServerConfig,
  },
} as const;
