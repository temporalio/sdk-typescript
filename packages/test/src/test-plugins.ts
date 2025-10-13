import { randomUUID } from 'crypto';
import anyTest, { TestFn } from 'ava';
import { Client, ClientOptions, ConnectionPlugin, ClientPlugin as ClientPlugin, ConnectionOptions } from '@temporalio/client';
import {
  WorkerOptions,
  WorkerPlugin as WorkerPlugin,
  ReplayWorkerOptions,
  Worker,
  BundlerPlugin,
  BundleOptions,
  bundleWorkflowCode, NativeConnectionPlugin,
  NativeConnectionOptions,
} from '@temporalio/worker';
import { native } from '@temporalio/core-bridge';
import { hello_workflow } from './workflows/plugins';
import { TestWorkflowEnvironment } from './helpers';

interface Context {
  testEnv: TestWorkflowEnvironment;
}
const test = anyTest as TestFn<Context>;

test.before(async (t) => {
  t.context = {
    testEnv: await TestWorkflowEnvironment.createLocal(),
  };
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

export class ExamplePlugin implements WorkerPlugin, ClientPlugin, BundlerPlugin, ConnectionPlugin, NativeConnectionPlugin {
  readonly name: string = 'example-plugin';

  constructor() {}

  configureClient(config: ClientOptions): ClientOptions {
    console.log('ExamplePlugin: Configuring client');
    config.identity = "Plugin Identity";
    return config;
  }

  configureWorker(config: WorkerOptions): WorkerOptions {
    console.log('ExamplePlugin: Configuring worker');
    config.taskQueue = 'plugin-task-queue';
    return config;
  }

  configureReplayWorker(config: ReplayWorkerOptions): ReplayWorkerOptions {
    return config;
  }

  runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void> {
    console.log('ExamplePlugin: Running worker');
    return next(worker);
  }

  configureBundler(config: BundleOptions): BundleOptions {
    console.log('Configure bundler');
    config.workflowsPath = require.resolve('./workflows/plugins');
    return config;
  }

  configureConnection(config: ConnectionOptions): ConnectionOptions {
    return config;
  }

  configureNativeConnection(options: NativeConnectionOptions): NativeConnectionOptions {
    return options;
  }

  connectNative(next: () => Promise<native.Client>): Promise<native.Client> {
    return next();
  }
}


test('Basic plugin', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });

  const plugin = new ExamplePlugin();
  const bundle = await bundleWorkflowCode({
    workflowsPath: 'replaced',
    plugins: [plugin]
  })

  const worker = await Worker.create({
    workflowBundle: bundle,
    connection: t.context.testEnv.nativeConnection,
    taskQueue: 'will be overridden',
    plugins: [plugin],
  });

  await worker.runUntil(async () => {
    t.is(worker.options.taskQueue, "plugin-task-queue");
    const result = await client.workflow.execute(hello_workflow, {
      taskQueue: "plugin-task-queue",
      workflowExecutionTimeout: '30 seconds',
      workflowId: randomUUID()
    });

    t.is(result, "Hello");
  });
});

test('Bundler plugins are passed from worker', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });

  const worker = await Worker.create({
    workflowsPath: 'replaced',
    connection: t.context.testEnv.nativeConnection,
    taskQueue: 'will be overridden',
    plugins: [new ExamplePlugin()],
  });
  console.log("worker created");
  await worker.runUntil(async () => {
    t.is(worker.options.taskQueue, "plugin-task-queue");
    const result = await client.workflow.execute(hello_workflow, {
      taskQueue: "plugin-task-queue",
      workflowExecutionTimeout: '30 seconds',
      workflowId: randomUUID()
    });

    t.is(result, "Hello");
  });
});


test('Worker plugins are passed from native connection', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal({connectionPlugins: [new ExamplePlugin()]});
  try {
    const client = new Client({ connection: env.connection });

    const worker = await Worker.create({
      workflowsPath: 'replaced',
      connection: env.nativeConnection,
      taskQueue: 'will be overridden',
    });

    t.is(worker.options.taskQueue, "plugin-task-queue");

    await worker.runUntil(async () => {
      t.is(worker.options.taskQueue, "plugin-task-queue");
      const result = await client.workflow.execute(hello_workflow, {
        taskQueue: "plugin-task-queue",
        workflowExecutionTimeout: '30 seconds',
        workflowId: randomUUID()
      });

      t.is(result, "Hello");
    });
  } finally {
    await env.teardown()
  }
});


test('Client plugins are passed from connections', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal({connectionPlugins: [new ExamplePlugin()]});
  try {
    const client = new Client({ connection: env.connection });
    t.is(client.options.identity, "Plugin Identity");

    const clientNative = new Client({ connection: env.nativeConnection });
    t.is(clientNative.options.identity, "Plugin Identity");
  } finally {
    await env.teardown()
  }
});