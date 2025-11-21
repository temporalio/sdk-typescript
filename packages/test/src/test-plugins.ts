import { randomUUID } from 'crypto';
import anyTest, { TestFn } from 'ava';
import { Client, ClientOptions, ConnectionPlugin, ClientPlugin as ClientPlugin } from '@temporalio/client';
import {
  WorkerOptions,
  WorkerPlugin as WorkerPlugin,
  Worker,
  BundlerPlugin,
  BundleOptions,
  bundleWorkflowCode,
  NativeConnectionPlugin,
} from '@temporalio/worker';
import { SimplePlugin } from '@temporalio/plugin';
import { activityWorkflow, helloWorkflow } from './workflows/plugins';
import { TestWorkflowEnvironment } from './helpers';

import * as activities from './activities';

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

export class ExamplePlugin
  implements WorkerPlugin, ClientPlugin, BundlerPlugin, ConnectionPlugin, NativeConnectionPlugin
{
  readonly name: string = 'example-plugin';

  constructor() {}

  configureClient(config: ClientOptions): ClientOptions {
    console.log('ExamplePlugin: Configuring client');
    config.identity = 'Plugin Identity';
    return config;
  }

  configureWorker(config: WorkerOptions): WorkerOptions {
    console.log('ExamplePlugin: Configuring worker');
    config.taskQueue = 'plugin-task-queue' + randomUUID();
    return config;
  }

  configureBundler(config: BundleOptions): BundleOptions {
    console.log('Configure bundler');
    config.workflowsPath = require.resolve('./workflows/plugins');
    return config;
  }
}

test('Basic plugin', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });

  const plugin = new ExamplePlugin();
  const bundle = await bundleWorkflowCode({
    workflowsPath: 'replaced',
    plugins: [plugin],
  });

  const worker = await Worker.create({
    workflowBundle: bundle,
    connection: t.context.testEnv.nativeConnection,
    taskQueue: 'will be overridden',
    plugins: [plugin],
  });

  await worker.runUntil(async () => {
    t.true(worker.options.taskQueue.startsWith('plugin-task-queue'));
    const result = await client.workflow.execute(helloWorkflow, {
      taskQueue: worker.options.taskQueue,
      workflowExecutionTimeout: '30 seconds',
      workflowId: randomUUID(),
    });

    t.is(result, 'Hello');
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
  await worker.runUntil(async () => {
    t.true(worker.options.taskQueue.startsWith('plugin-task-queue'));
    const result = await client.workflow.execute(helloWorkflow, {
      taskQueue: worker.options.taskQueue,
      workflowExecutionTimeout: '30 seconds',
      workflowId: randomUUID(),
    });

    t.is(result, 'Hello');
  });
});

test('Worker plugins are passed from native connection', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal({ plugins: [new ExamplePlugin()] });
  try {
    const client = new Client({ connection: env.connection });

    const worker = await Worker.create({
      workflowsPath: 'replaced',
      connection: env.nativeConnection,
      taskQueue: 'will be overridden',
    });

    t.true(worker.options.taskQueue.startsWith('plugin-task-queue'));

    await worker.runUntil(async () => {
      t.true(worker.options.taskQueue.startsWith('plugin-task-queue'));
      const result = await client.workflow.execute(helloWorkflow, {
        taskQueue: worker.options.taskQueue,
        workflowExecutionTimeout: '30 seconds',
        workflowId: randomUUID(),
      });

      t.is(result, 'Hello');
    });
  } finally {
    await env.teardown();
  }
});

test('Client plugins are passed from connections', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal({ plugins: [new ExamplePlugin()] });
  try {
    const client = new Client({ connection: env.connection });
    t.is(client.options.identity, 'Plugin Identity');

    const clientNative = new Client({ connection: env.nativeConnection });
    t.is(clientNative.options.identity, 'Plugin Identity');
  } finally {
    await env.teardown();
  }
});

test('Bundler plugins are passed from connections', async (t) => {
  const plugin = new (class implements BundlerPlugin {
    name: string = 'plugin';
    configureBundler(options: BundleOptions): BundleOptions {
      return { ...options, workflowsPath: require.resolve('./workflows/plugins') };
    }
  })();
  const env = await TestWorkflowEnvironment.createLocal({ plugins: [plugin] });
  try {
    const client = new Client({ connection: env.connection });
    const worker = await Worker.create({
      workflowsPath: 'replaced',
      connection: env.nativeConnection,
      taskQueue: 'plugin-task-queue' + randomUUID(),
    });

    await worker.runUntil(async () => {
      t.true(worker.options.taskQueue.startsWith('plugin-task-queue'));
      const result = await client.workflow.execute(helloWorkflow, {
        taskQueue: worker.options.taskQueue,
        workflowExecutionTimeout: '30 seconds',
        workflowId: randomUUID(),
      });

      t.is(result, 'Hello');
    });
  } finally {
    await env.teardown();
  }
});

// SimplePlugin tests
test('SimplePlugin connection configurations', async (t) => {
  const plugin = new SimplePlugin({
    name: 'test-simple-plugin',
    tls: true,
    apiKey: 'testApiKey',
  });

  const options = plugin.configureNativeConnection({});
  t.is(options.tls, true);
  t.is(options.apiKey, 'testApiKey');
});

test('SimplePlugin worker configurations', async (t) => {
  const plugin = new SimplePlugin({
    name: 'test-simple-plugin',
    activities,
    workflowsPath: require.resolve('./workflows/plugins'),
  });

  const { connection } = t.context.testEnv;
  const client = new Client({ connection });

  const worker = await Worker.create({
    workflowsPath: 'replaced',
    connection: t.context.testEnv.nativeConnection,
    taskQueue: 'simple-plugin-queue' + randomUUID(),
    plugins: [plugin],
  });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(activityWorkflow, {
      taskQueue: worker.options.taskQueue,
      workflowExecutionTimeout: '30 seconds',
      workflowId: randomUUID(),
    });

    t.is(result, 'Hello');
  });
});

test('SimplePlugin with activities merges them correctly', async (t) => {
  const activity1 = async () => 'activity1';
  const activity2 = async () => 'activity2';

  const plugin = new SimplePlugin({
    name: 'simple-test-plugin',
    activities: {
      pluginActivity: activity2,
    },
  });

  const worker = await Worker.create({
    connection: t.context.testEnv.nativeConnection,
    taskQueue: 'simple-plugin-queue' + randomUUID(),
    activities: {
      existingActivity: activity1,
    },
    plugins: [plugin],
  });

  t.truthy(worker.options.activities);
  t.truthy(worker.options.activities.has('existingActivity'));
  t.truthy(worker.options.activities.has('pluginActivity'));
});
