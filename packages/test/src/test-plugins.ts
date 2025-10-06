import { randomUUID } from 'crypto';
import anyTest, { TestFn } from 'ava';
import { Client, ClientOptions, Plugin as ClientPlugin } from '@temporalio/client';
import {
  WorkerOptions,
  Plugin as WorkerPlugin,
  ReplayWorkerOptions,
  Worker,
  BundlerPlugin,
  BundleOptions,
  bundleWorkflowCode,
} from '@temporalio/worker';
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

export class ExamplePlugin implements WorkerPlugin, ClientPlugin, BundlerPlugin {
  readonly name: string = 'example-plugin';
  private nextClientPlugin?: ClientPlugin;
  private nextWorkerPlugin?: WorkerPlugin;
  private nextBundlerPlugin?: BundlerPlugin;

  constructor() {}

  initClientPlugin(next: ClientPlugin): ClientPlugin {
    this.nextClientPlugin = next;
    return this;
  }

  configureClient(config: ClientOptions): ClientOptions {
    console.log('ExamplePlugin: Configuring client');

    // Chain to next plugin
    return this.nextClientPlugin!.configureClient(config);
  }

  initWorkerPlugin(next: WorkerPlugin): WorkerPlugin {
    this.nextWorkerPlugin = next;
    return this;
  }

  /**
   * Configure worker with custom task queue and additional settings
   */
  configureWorker(config: WorkerOptions): WorkerOptions {
    console.log('ExamplePlugin: Configuring worker');
    config.taskQueue = 'plugin-task-queue';

    // Chain to next plugin
    return this.nextWorkerPlugin!.configureWorker(config);
  }

  configureReplayWorker(config: ReplayWorkerOptions): ReplayWorkerOptions {
    return this.nextWorkerPlugin!.configureReplayWorker(config);
  }

  runWorker(worker: Worker): Promise<void> {
    return this.nextWorkerPlugin!.runWorker(worker);
  }

  initBundlerPlugin(next: BundlerPlugin): BundlerPlugin {
    this.nextBundlerPlugin = next;
    return this;
  }

  configureBundler(config: BundleOptions): BundleOptions {
    console.log("Configure bundler")
    config.workflowsPath = require.resolve('./workflows/plugins');
    return this.nextBundlerPlugin!.configureBundler(config);
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