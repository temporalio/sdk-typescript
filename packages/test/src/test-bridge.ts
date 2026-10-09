import { setTimeout } from 'node:timers/promises';
import ms from 'ms';
import type { ExecutionContext } from 'ava';
import test from 'ava';
import { native, errors } from '@temporalio/core-bridge';
import { toNativeClientOptions } from '@temporalio/worker/lib/connection-options';
import type { Context as IntegrationContext } from './helpers-integration';
import { helpers, makeTestFunction } from './helpers-integration';

// TESTING NOTES
//
// - Tests in this file requires an external Temporal server to be running, because using the ephemeral
//   server support provided by Core SDK would affect the behavior that we're testing here.
// - Tests in this file can't be run in parallel, since the bridge is mostly a singleton.
// - Some of these tests explicitly use the native bridge, without going through the lang side Runtime/Worker.

const integrationTest = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

function nativeClientOptions(t: ExecutionContext<IntegrationContext>): native.ClientOptions {
  return toNativeClientOptions({
    ...t.context.env.connectionOptions,
    address: t.context.env.address,
  });
}

function nativeWorkerOptions(t: ExecutionContext<IntegrationContext>): native.WorkerOptions {
  return {
    ...GenericConfigs.worker.basic,
    namespace: t.context.env.client.options.namespace,
    taskQueue: helpers(t).taskQueue,
  };
}

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

integrationTest.serial('Can run multiple runtime concurrently', async (t) => {
  const runtime1 = native.newRuntime(GenericConfigs.runtime.basic);
  const runtime2 = native.newRuntime(GenericConfigs.runtime.basic);
  const runtime3 = native.newRuntime(GenericConfigs.runtime.basic);

  // Order is intentionally random - distinct runtimes are expected to be independent
  const clientOptions = nativeClientOptions(t);
  const _client2 = await native.newClient(runtime3, clientOptions);
  const _client1 = await native.newClient(runtime1, clientOptions);
  const _client3 = await native.newClient(runtime2, clientOptions);

  native.runtimeShutdown(runtime1);
  native.runtimeShutdown(runtime3);

  await t.throwsAsync(async () => await native.newClient(runtime1, clientOptions), {
    instanceOf: errors.IllegalStateError,
    message: 'Runtime already closed',
  });

  const _client5 = await native.newClient(runtime2, clientOptions);

  native.runtimeShutdown(runtime2);

  t.pass();
});

test('Missing/invalid properties in config throws appropriately', async (t) => {
  t.throws(
    () =>
      native.newRuntime({
        ...GenericConfigs.runtime.basic,
        logExporter: {
          type: 'console',
          filter: 'ERROR',
          format: 'xml' as 'json',
        },
      }),
    {
      instanceOf: TypeError,
      message: /Expected 'compact', 'pretty', or 'json'/,
    }
  );

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
  const time_1 = native.getTimeOfDay();
  const time_2 = native.getTimeOfDay();
  await setTimeout(100);
  const time_3 = native.getTimeOfDay();

  t.is(typeof time_1, 'bigint');
  t.true(time_1 < time_2);

  // We only care about rough scale, so let's say at least 40ms should have passed, to avoid flakes
  t.true(time_2 + 40_000_000n < time_3);
});

test("Creating Runtime without shutting it down doesn't hang process", (t) => {
  const _runtime = native.newRuntime(GenericConfigs.runtime.basic);
  t.pass();
});

integrationTest("Dropping Client without closing doesn't hang process", (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const _client = native.newClient(runtime, nativeClientOptions(t));
  t.pass();
});

integrationTest("Dropping Worker without shutting it down doesn't hang process", async (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const client = await native.newClient(runtime, nativeClientOptions(t));
  const worker = native.newWorker(client, nativeWorkerOptions(t));
  t.true(Buffer.isBuffer(await native.workerValidate(worker)));
  t.pass();
});

// FIXME(JWH): This is causing hangs on shutdown on Windows.
test("Dropping EphemeralServer without shutting it down doesn't hang process", async (t) => {
  const runtime = native.newRuntime(GenericConfigs.runtime.basic);
  const _ephemeralServer = await native.newEphemeralServer(runtime, GenericConfigs.ephemeralServer.basic);
  t.pass();
});

integrationTest.serial("Stopping Worker after creating another runtime doesn't fail", async (t) => {
  async function expectShutdownError(taskPromise: () => Promise<Buffer>) {
    await t.throwsAsync(taskPromise, {
      instanceOf: errors.ShutdownError,
    });
  }

  const runtime0 = native.newRuntime(GenericConfigs.runtime.basic);
  const runtime1 = native.newRuntime(GenericConfigs.runtime.basic);

  // Starts Worker 0
  const clientOptions = nativeClientOptions(t);
  const workerOptions = nativeWorkerOptions(t);
  const client0 = await native.newClient(runtime0, clientOptions);
  const worker0 = native.newWorker(client0, workerOptions);
  await native.workerValidate(worker0);

  // Start Worker 1
  const client1 = await native.newClient(runtime1, clientOptions);
  const worker1 = native.newWorker(client1, workerOptions);
  await native.workerValidate(worker1);

  // Start polling on Worker 1 (note reverse order of Worker 0)
  const expectErrorWft1 = expectShutdownError(() => native.workerPollWorkflowActivation(worker1));
  const expectErrorPromise1 = expectShutdownError(() => native.workerPollActivityTask(worker1));

  // Start polling on Worker 0
  const expectErrorWft0 = expectShutdownError(() => native.workerPollWorkflowActivation(worker0));
  const expectErrorPromise0 = expectShutdownError(() => native.workerPollActivityTask(worker0));

  // Cleanly shutdown Worker 1
  native.workerInitiateShutdown(worker1);
  await expectErrorWft1;
  await expectErrorPromise1;
  await native.workerFinalizeShutdown(worker1);
  // Leave Client 1 and Runtime 1 alive

  // Create Runtime 2 and Worker 2, but don't immediately use them
  const runtime2 = native.newRuntime(GenericConfigs.runtime.basic);
  const client2 = await native.newClient(runtime2, clientOptions);
  const worker2 = native.newWorker(client2, workerOptions);

  // Cleanly shutdown Worker 0
  native.workerInitiateShutdown(worker0);
  await expectErrorWft0;
  await expectErrorPromise0;
  await native.workerFinalizeShutdown(worker0);
  native.clientClose(client0);
  native.runtimeShutdown(runtime0);

  // Start yet another runtime, we really won't use it
  const _runtime3 = native.newRuntime(GenericConfigs.runtime.basic);

  // Start polling on Worker 2, then shut it down cleanly
  await native.workerValidate(worker2);
  const expectErrorWft2 = expectShutdownError(() => native.workerPollWorkflowActivation(worker2));
  const expectErrorPromise2 = expectShutdownError(() => native.workerPollActivityTask(worker2));
  native.workerInitiateShutdown(worker2);
  await expectErrorWft2;
  await expectErrorPromise2;
  await native.workerFinalizeShutdown(worker2);
  native.clientClose(client2);
  native.runtimeShutdown(runtime2);

  t.pass();
});

// Sample configs ///////////////////////////////////////////////////////////////////////////////////

const GenericConfigs = {
  runtime: {
    basic: {
      logExporter: {
        type: 'console',
        filter: 'ERROR',
        format: null,
      },
      telemetry: {
        metricPrefix: 'test',
        attachServiceName: false,
      },
      metricsExporter: null,
      workerHeartbeatIntervalMillis: null,
    } satisfies native.RuntimeOptions,
  },
  client: {
    basic: {
      targetUrl: 'http://127.0.0.1:7233',
      clientName: 'temporal-typescript-test',
      clientVersion: '1.0.0',
      tls: null,
      httpConnectProxy: null,
      dnsLoadBalancingConfig: null,
      grpcCompression: { codec: 'gzip' },
      headers: null,
      apiKey: null,
      disableErrorCodeMetricTags: false,
      payloadsWarnSize: 512 * 1024,
      memoWarnSize: 2 * 1024,
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
        resourceBasedTunerConfig: null,
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
      taskTypes: {
        enableWorkflows: true,
        enableLocalActivities: false,
        enableRemoteActivities: false,
        enableNexus: false,
      },
      stickyQueueScheduleToStartTimeout: 1000,
      maxCachedWorkflows: 1000,
      maxHeartbeatThrottleInterval: 1000,
      defaultHeartbeatThrottleInterval: 1000,
      maxTaskQueueActivitiesPerSecond: null,
      maxActivitiesPerSecond: null,
      maxEagerActivityReservationsPerWorkflowTask: 3,
      shutdownGraceTime: 1000,
      plugins: [],
      storageDrivers: [],
      workflowFailureErrors: [],
      workflowTypesToFailureErrors: {},
      disablePayloadErrorLimit: false,
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
