import test from 'ava';
import type { WorkerOptions, NativeConnectionOptions } from '@temporalio/worker';
import { runWorker, type LambdaWorkerConfig } from '@temporalio/lambda-worker';
import { type WorkerDeps, _runWorkerInternal } from '@temporalio/lambda-worker/lib/lambda-worker';
import { LAMBDA_WORKER_DEFAULTS } from '@temporalio/lambda-worker/lib/defaults';

const TEST_VERSION = { buildId: 'test-build', deploymentName: 'test-deployment' };

// Minimal mock that satisfies the Context interface used by the handler
function makeMockContext(
  remainingMs: number,
  requestId = 'req-abc-123',
  arn = 'arn:aws:lambda:us-east-1:123456:function:my-func'
): any {
  return {
    awsRequestId: requestId,
    invokedFunctionArn: arn,
    getRemainingTimeInMillis: () => remainingMs,
  };
}

const noopLogger = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function makeTestDeps(overrides?: Partial<WorkerDeps>): WorkerDeps {
  return {
    connect: async () => ({ close: async () => {} }),
    createWorker: async () => ({ runUntil: async () => {} }),
    loadConnectConfig: () => ({ connectionOptions: {}, namespace: 'default' }),
    installRuntime: () => {},
    getLogger: () => noopLogger,
    ...overrides,
  };
}

// ---- Config and Defaults Tests ----

test('workerDeploymentOptions defaults to PINNED in config', (t) => {
  let captured: LambdaWorkerConfig | undefined;
  _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      captured = config;
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps()
  );

  const opts = captured!.workerOptions.workerDeploymentOptions;
  t.truthy(opts);
  t.is(opts!.defaultVersioningBehavior, 'PINNED');
});

test('workerDeploymentOptions on final WorkerOptions includes version and useWorkerVersioning', async (t) => {
  let capturedWorkerOpts: WorkerOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps({
      createWorker: async (opts) => {
        capturedWorkerOpts = opts;
        return { runUntil: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  const opts = capturedWorkerOpts!.workerDeploymentOptions;
  t.truthy(opts);
  t.deepEqual(opts!.version, TEST_VERSION);
  t.is(opts!.useWorkerVersioning, true);
  t.is(opts!.defaultVersioningBehavior, 'PINNED');
});

test('user can override defaultVersioningBehavior to AUTO_UPGRADE', async (t) => {
  let capturedWorkerOpts: WorkerOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.workerOptions.workerDeploymentOptions = {
        defaultVersioningBehavior: 'AUTO_UPGRADE',
      };
    },
    makeTestDeps({
      createWorker: async (opts) => {
        capturedWorkerOpts = opts;
        return { runUntil: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  const opts = capturedWorkerOpts!.workerDeploymentOptions;
  t.is(opts!.defaultVersioningBehavior, 'AUTO_UPGRADE');
  t.is(opts!.useWorkerVersioning, true);
  t.deepEqual(opts!.version, TEST_VERSION);
});

test('throws if taskQueue is not set', (t) => {
  t.throws(() => _runWorkerInternal(TEST_VERSION, () => {}, makeTestDeps()), { message: /taskQueue is required/ });
});

test('Lambda defaults applied to workerOptions', (t) => {
  let captured: LambdaWorkerConfig | undefined;
  _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      captured = config;
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps()
  );

  const opts = captured!.workerOptions;
  t.is(opts.maxConcurrentActivityTaskExecutions, LAMBDA_WORKER_DEFAULTS.maxConcurrentActivityTaskExecutions);
  t.is(opts.maxConcurrentWorkflowTaskExecutions, LAMBDA_WORKER_DEFAULTS.maxConcurrentWorkflowTaskExecutions);
  t.is(opts.maxConcurrentLocalActivityExecutions, LAMBDA_WORKER_DEFAULTS.maxConcurrentLocalActivityExecutions);
  t.is(opts.maxConcurrentNexusTaskExecutions, LAMBDA_WORKER_DEFAULTS.maxConcurrentNexusTaskExecutions);
  t.is(opts.shutdownGraceTime, LAMBDA_WORKER_DEFAULTS.shutdownGraceTime);
  t.is(opts.maxCachedWorkflows, LAMBDA_WORKER_DEFAULTS.maxCachedWorkflows);
  t.deepEqual(opts.workflowTaskPollerBehavior, LAMBDA_WORKER_DEFAULTS.workflowTaskPollerBehavior);
  t.deepEqual(opts.activityTaskPollerBehavior, LAMBDA_WORKER_DEFAULTS.activityTaskPollerBehavior);
  t.deepEqual(opts.nexusTaskPollerBehavior, LAMBDA_WORKER_DEFAULTS.nexusTaskPollerBehavior);
});

test('user overrides take precedence over Lambda defaults', async (t) => {
  let capturedWorkerOpts: WorkerOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'user-queue';
      config.workerOptions.maxConcurrentActivityTaskExecutions = 99;
    },
    makeTestDeps({
      createWorker: async (opts) => {
        capturedWorkerOpts = opts;
        return { runUntil: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  t.is(capturedWorkerOpts!.taskQueue, 'user-queue');
  t.is(capturedWorkerOpts!.maxConcurrentActivityTaskExecutions, 99);
});

test('configure callback receives pre-populated config with defaults', (t) => {
  let captured: LambdaWorkerConfig | undefined;
  _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      captured = config;
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps()
  );

  t.truthy(captured);
  t.is(captured!.workerOptions.maxConcurrentActivityTaskExecutions, 2);
  t.is(captured!.workerOptions.workerDeploymentOptions!.defaultVersioningBehavior, 'PINNED');
  t.deepEqual(captured!.shutdownHooks, []);
});

test('runtimeOptions pre-populated with shutdownSignals disabled', (t) => {
  let captured: LambdaWorkerConfig | undefined;
  _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      captured = config;
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps()
  );

  t.deepEqual(captured!.runtimeOptions.shutdownSignals, []);
});

test('Runtime.install called with runtimeOptions', (t) => {
  let installedOptions: any;
  _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps({
      installRuntime: (opts) => {
        installedOptions = opts;
      },
    })
  );

  t.truthy(installedOptions);
  t.deepEqual(installedOptions.shutdownSignals, []);
});

test('user can override runtimeOptions.logger', (t) => {
  const customLogger = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  let installedOptions: any;
  _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.runtimeOptions.logger = customLogger;
    },
    makeTestDeps({
      installRuntime: (opts) => {
        installedOptions = opts;
      },
    })
  );

  t.is(installedOptions.logger, customLogger);
});

test('task queue from configure callback', async (t) => {
  let capturedWorkerOpts: WorkerOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'explicit-queue';
    },
    makeTestDeps({
      createWorker: async (opts) => {
        capturedWorkerOpts = opts;
        return { runUntil: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  t.is(capturedWorkerOpts!.taskQueue, 'explicit-queue');
});

test('task queue pre-populated from TEMPORAL_TASK_QUEUE env var', (t) => {
  const original = process.env['TEMPORAL_TASK_QUEUE'];
  try {
    process.env['TEMPORAL_TASK_QUEUE'] = 'env-queue';
    let captured: LambdaWorkerConfig | undefined;
    _runWorkerInternal(
      TEST_VERSION,
      (config) => {
        captured = config;
      },
      makeTestDeps()
    );

    t.is(captured!.workerOptions.taskQueue, 'env-queue');
  } finally {
    if (original === undefined) {
      delete process.env['TEMPORAL_TASK_QUEUE'];
    } else {
      process.env['TEMPORAL_TASK_QUEUE'] = original;
    }
  }
});

test('user namespace override applied', async (t) => {
  let capturedWorkerOpts: WorkerOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.namespace = 'custom-ns';
    },
    makeTestDeps({
      createWorker: async (opts) => {
        capturedWorkerOpts = opts;
        return { runUntil: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  t.is(capturedWorkerOpts!.namespace, 'custom-ns');
});

// ---- Identity Tests ----

test('identity built from Lambda context', async (t) => {
  let capturedWorkerOpts: WorkerOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps({
      createWorker: async (opts) => {
        capturedWorkerOpts = opts;
        return { runUntil: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000, 'req-abc-123', 'arn:aws:lambda:us-east-1:123456:function:my-func'));
  t.is(capturedWorkerOpts!.identity, 'req-abc-123@arn:aws:lambda:us-east-1:123456:function:my-func');
});

// ---- Shutdown Hook Tests ----

test('shutdown hooks called', async (t) => {
  let shutdownCalled = false;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(() => {
        shutdownCalled = true;
      });
    },
    makeTestDeps()
  );

  await handler({}, makeMockContext(60_000));
  t.true(shutdownCalled);
});

test('shutdown hooks called per invocation', async (t) => {
  let shutdownCount = 0;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(() => {
        shutdownCount++;
      });
    },
    makeTestDeps()
  );

  await handler({}, makeMockContext(60_000));
  await handler({}, makeMockContext(60_000));
  await handler({}, makeMockContext(60_000));
  t.is(shutdownCount, 3);
});

test('multiple shutdown hooks run in order', async (t) => {
  const order: string[] = [];
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(() => {
        order.push('first');
      });
      config.shutdownHooks.push(() => {
        order.push('second');
      });
    },
    makeTestDeps()
  );

  await handler({}, makeMockContext(60_000));
  t.deepEqual(order, ['first', 'second']);
});

test('async shutdown hooks are awaited', async (t) => {
  let called = false;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(async () => {
        await new Promise((r) => setTimeout(r, 10));
        called = true;
      });
    },
    makeTestDeps()
  );

  await handler({}, makeMockContext(60_000));
  t.true(called);
});

test('shutdown hook error does not prevent subsequent hooks', async (t) => {
  let secondCalled = false;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(() => {
        throw new Error('hook failed');
      });
      config.shutdownHooks.push(() => {
        secondCalled = true;
      });
    },
    makeTestDeps()
  );

  await handler({}, makeMockContext(60_000));
  t.true(secondCalled);
});

// ---- Deadline Tests ----

test('tight deadline throws error', async (t) => {
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps()
  );

  // remaining = 2000, buffer = 7000 (default), work time = -5000 <= 1000
  await t.throwsAsync(() => handler({}, makeMockContext(2000)), { message: /Insufficient time for Lambda worker/ });
});

test('tight deadline with custom buffer throws error', async (t) => {
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownDeadlineBufferMs = 1500;
    },
    makeTestDeps()
  );

  // remaining = 2000, buffer = 1500, work time = 500 <= 1000
  await t.throwsAsync(() => handler({}, makeMockContext(2000)), { message: /Insufficient time for Lambda worker/ });
});

test('low work time logs warning', async (t) => {
  let warnCalled = false;
  let warnMessage = '';
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownDeadlineBufferMs = 500;
    },
    makeTestDeps({
      getLogger: () => ({
        log() {},
        trace() {},
        debug() {},
        info() {},
        warn(msg: string) {
          warnCalled = true;
          warnMessage = msg;
        },
        error() {},
      }),
    })
  );

  // remaining = 4000, buffer = 500, work time = 3500 < 5000 (warn threshold)
  await handler({}, makeMockContext(4000));
  t.true(warnCalled);
  t.true(warnMessage.includes('Low work time'));
});

// ---- Per-Invocation Lifecycle Tests ----

test('new connection created per invocation', async (t) => {
  let connectCount = 0;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps({
      connect: async () => {
        connectCount++;
        return { close: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  await handler({}, makeMockContext(60_000));
  await handler({}, makeMockContext(60_000));
  t.is(connectCount, 3);
});

test('connection closed after worker completes', async (t) => {
  const order: string[] = [];
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps({
      createWorker: async () => ({
        runUntil: async () => {
          order.push('worker.runUntil');
        },
      }),
      connect: async () => ({
        close: async () => {
          order.push('connection.close');
        },
      }),
    })
  );

  await handler({}, makeMockContext(60_000));
  t.deepEqual(order, ['worker.runUntil', 'connection.close']);
});

test('shutdown hooks run after worker completes but before connection close', async (t) => {
  const order: string[] = [];
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(() => {
        order.push('shutdown-hook');
      });
    },
    makeTestDeps({
      createWorker: async () => ({
        runUntil: async () => {
          order.push('worker.runUntil');
        },
      }),
      connect: async () => ({
        close: async () => {
          order.push('connection.close');
        },
      }),
    })
  );

  await handler({}, makeMockContext(60_000));
  t.deepEqual(order, ['worker.runUntil', 'shutdown-hook', 'connection.close']);
});

test('connection closed even if worker creation fails', async (t) => {
  let closeCalled = false;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
    },
    makeTestDeps({
      createWorker: async () => {
        throw new Error('worker creation failed');
      },
      connect: async () => ({
        close: async () => {
          closeCalled = true;
        },
      }),
    })
  );

  await t.throwsAsync(() => handler({}, makeMockContext(60_000)), { message: /worker creation failed/ });
  t.true(closeCalled);
});

test('shutdown hooks run even if worker creation fails', async (t) => {
  let hookCalled = false;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      config.shutdownHooks.push(() => {
        hookCalled = true;
      });
    },
    makeTestDeps({
      createWorker: async () => {
        throw new Error('worker creation failed');
      },
    })
  );

  await t.throwsAsync(() => handler({}, makeMockContext(60_000)));
  t.true(hookCalled);
});

// ---- Connection Options Tests ----

test('connectionOptions pre-populated from envconfig', async (t) => {
  let capturedOpts: NativeConnectionOptions | undefined;
  const handler = _runWorkerInternal(
    TEST_VERSION,
    (config) => {
      config.workerOptions.taskQueue = 'q';
      // User sees envconfig values and can selectively override
      t.is(config.connectionOptions!.address, 'envconfig:7233');
      t.is(config.connectionOptions!.apiKey, 'from-env');
      config.connectionOptions!.address = 'user-override:7233';
    },
    makeTestDeps({
      loadConnectConfig: () => ({
        connectionOptions: { address: 'envconfig:7233', apiKey: 'from-env' },
        namespace: 'default',
      }),
      connect: async (opts) => {
        capturedOpts = opts;
        return { close: async () => {} };
      },
    })
  );

  await handler({}, makeMockContext(60_000));
  t.is(capturedOpts!.address, 'user-override:7233');
  t.is(capturedOpts!.apiKey, 'from-env');
});
