/** Bundler tests that execute Workflows against a server. */
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join as pathJoin } from 'node:path';
import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import type { WorkerOptions } from '@temporalio/worker';
import { bundleWorkflowCode } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from './helpers';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { createTestWorkflowEnvironment, makeConfigurableEnvironmentTestFn } from './helpers-integration';
import { ModuleCacheWhitespaceCollapsePlugin } from './bundler-test-helpers';
import { issue516 } from './mocks/workflows-with-node-dependencies/issue-516';
import { preloadSharedCounter } from './workflows/preload-shared-counter';
import { workflowWithPrebundledDep } from './workflows/workflow-with-prebundled-dep';
import { successString } from './workflows';

async function runPreloadSharedCounter(
  t: ExecutionContext<{ env: TestWorkflowEnvironment }>,
  workerOptions: Pick<WorkerOptions, 'bundlerOptions' | 'workflowBundle' | 'workflowsPath'>
): Promise<[number, number]> {
  const { env } = t.context;
  const taskQueue = `${t.title}-${randomUUID()}`;
  const client = new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
  });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    reuseV8Context: true,
    ...workerOptions,
  });
  return await worker.runUntil(async () => {
    const first = await client.workflow.execute(preloadSharedCounter, { taskQueue, workflowId: randomUUID() });
    const second = await client.workflow.execute(preloadSharedCounter, { taskQueue, workflowId: randomUUID() });
    return [first, second];
  });
}

if (RUN_INTEGRATION_TESTS) {
  const test = makeConfigurableEnvironmentTestFn<{ env: TestWorkflowEnvironment }>({
    createTestContext: async () => ({ env: await createTestWorkflowEnvironment() }),
    teardown: async ({ env }) => env.teardown(),
  });

  test('Worker can be created from bundle code', async (t) => {
    const { env } = t.context;
    const taskQueue = `${t.title}-${randomUUID()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.client.options.namespace,
      taskQueue,
      workflowBundle,
    });
    const client = new Client({
      connection: env.client.connection,
      namespace: env.client.options.namespace,
    });
    await worker.runUntil(client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));
    t.pass();
  });

  test('Worker can be created from bundle path', async (t) => {
    const { env } = t.context;
    const taskQueue = `${t.title}-${randomUUID()}`;
    const { code } = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const uid = randomUUID();
    const codePath = pathJoin(os.tmpdir(), `workflow-bundle-${uid}.js`);
    await writeFile(codePath, code);
    const workflowBundle = { codePath };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.client.options.namespace,
      taskQueue,
      workflowBundle,
    });
    const client = new Client({
      connection: env.client.connection,
      namespace: env.client.options.namespace,
    });
    try {
      await worker.runUntil(client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));
    } finally {
      await unlink(codePath);
    }
    t.pass();
  });

  test('Workflow bundle can be created from code using ignoreModules', async (t) => {
    const { env } = t.context;
    const taskQueue = `${t.title}-${randomUUID()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
      ignoreModules: ['dns'],
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.client.options.namespace,
      taskQueue,
      workflowBundle,
    });
    const client = new Client({
      connection: env.client.connection,
      namespace: env.client.options.namespace,
    });
    await worker.runUntil(client.workflow.execute(issue516, { taskQueue, workflowId: randomUUID() }));
    t.pass();
  });

  test('Workflow bundle can preload modules into the reusable V8 context', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      preloadModules: [require.resolve('./workflows/preload-shared-counter-helper')],
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 2]);
  });

  test('Workflow bundle keeps module state isolated without preloadModules', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });

  test('Workflow bundle treats an empty preloadModules list as a no-op', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      preloadModules: [],
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });

  test('WorkerOptions.bundlerOptions.preloadModules works', async (t) => {
    t.deepEqual(
      await runPreloadSharedCounter(t, {
        workflowsPath: require.resolve('./workflows/preload-shared-counter'),
        bundlerOptions: {
          preloadModules: [require.resolve('./workflows/preload-shared-counter-helper')],
        },
      }),
      [1, 2]
    );
  });

  // Regression test for https://github.com/temporalio/sdk-typescript/issues/2188:
  // module state must remain isolated even when a pre-bundled dependency (shipping
  // its own nested `__webpack_module_cache__`) is included in the Workflow bundle.
  test('Workflow bundle keeps module state isolated with a pre-bundled dependency (#2188)', async (t) => {
    const { env } = t.context;
    const taskQueue = `${t.title}-${randomUUID()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/workflow-with-prebundled-dep'),
    });
    const client = new Client({
      connection: env.client.connection,
      namespace: env.client.options.namespace,
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.client.options.namespace,
      taskQueue,
      reuseV8Context: true,
      workflowBundle,
    });
    const results = await worker.runUntil(async () => {
      const first = await client.workflow.execute(workflowWithPrebundledDep, { taskQueue, workflowId: randomUUID() });
      const second = await client.workflow.execute(workflowWithPrebundledDep, { taskQueue, workflowId: randomUUID() });
      return [first, second];
    });
    t.deepEqual(results, [1, 1]);
  });

  // Regression test for https://github.com/temporalio/sdk-typescript/issues/2170#issuecomment-4925636742:
  // module state must remain isolated even when the bundle is minified after webpack.
  test('Workflow bundle keeps module state isolated when minified after webpack (#2170 (comment))', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      webpackConfigHook: (config) => {
        config.plugins = [...(config.plugins ?? []), new ModuleCacheWhitespaceCollapsePlugin()];
        return config;
      },
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });
}
