import { randomUUID } from 'crypto';
import * as libCoverage from 'istanbul-lib-coverage';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';
import type { TestWorkflowEnvironment } from './helpers';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { createTestWorkflowEnvironment, makeConfigurableEnvironmentTestFn } from './helpers-integration';
import { successString } from './workflows';

declare global {
  var __coverage__: libCoverage.CoverageMapData;
}

if (RUN_INTEGRATION_TESTS) {
  const test = makeConfigurableEnvironmentTestFn<{ env: TestWorkflowEnvironment }>({
    createTestContext: async () => ({ env: await createTestWorkflowEnvironment() }),
    teardown: async ({ env }) => env.teardown(),
  });

  test('Istanbul injector execute correctly in Worker', async (t) => {
    const { env } = t.context;
    // Make it believe that NYC has been loaded
    (global as any).__coverage__ = {};

    const workflowCoverage = new WorkflowCoverage();

    const taskQueue = `${t.title}-${randomUUID()}`;
    const worker = await Worker.create(
      workflowCoverage.augmentWorkerOptions({
        connection: env.nativeConnection,
        namespace: env.client.options.namespace,
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
      })
    );
    await worker.runUntil(env.client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));

    workflowCoverage.mergeIntoGlobalCoverage();
    const coverageMap = libCoverage.createCoverageMap(global.__coverage__);

    const successStringFileName = coverageMap.files().find((x) => x.match(/[/\\]success-string\.js/));
    if (successStringFileName) {
      t.is(coverageMap.fileCoverageFor(successStringFileName).toSummary().lines.pct, 100);
    } else t.fail();
  });

  test('Istanbul injector execute correctly in Bundler', async (t) => {
    const { env } = t.context;
    const workflowCoverageBundler = new WorkflowCoverage();
    const { code } = await bundleWorkflowCode(
      workflowCoverageBundler.augmentBundleOptions({
        workflowsPath: require.resolve('./workflows'),
      })
    );

    // Make it believe that NYC has been loaded
    (global as any).__coverage__ = {};

    const workflowCoverageWorker = new WorkflowCoverage();
    const taskQueue = `${t.title}-${randomUUID()}`;
    const worker = await Worker.create(
      workflowCoverageWorker.augmentWorkerOptionsWithBundle({
        connection: env.nativeConnection,
        namespace: env.client.options.namespace,
        taskQueue,
        workflowBundle: { code },
      })
    );
    await worker.runUntil(env.client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));

    workflowCoverageBundler.mergeIntoGlobalCoverage();
    workflowCoverageWorker.mergeIntoGlobalCoverage();
    const coverageMap = libCoverage.createCoverageMap(global.__coverage__);
    const successStringFileName = coverageMap.files().find((x) => x.match(/[/\\]success-string\.js/));
    if (successStringFileName) {
      t.is(coverageMap.fileCoverageFor(successStringFileName).toSummary().lines.pct, 100);
    } else t.fail();
  });

  test('Istanbul injector exclude non-user code', async (t) => {
    const { env } = t.context;
    // Make it believe that NYC has been loaded
    (global as any).__coverage__ = {};

    const workflowCoverage = new WorkflowCoverage();

    const taskQueue = `${t.title}-${randomUUID()}`;
    const worker = await Worker.create(
      workflowCoverage.augmentWorkerOptions({
        connection: env.nativeConnection,
        namespace: env.client.options.namespace,
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
      })
    );
    await worker.runUntil(env.client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));

    workflowCoverage.mergeIntoGlobalCoverage();
    const coverageMap = libCoverage.createCoverageMap(global.__coverage__);

    // Only user code should be included in coverage
    t.is(coverageMap.files().filter((x) => x.match(/[/\\]worker-interface.js/)).length, 0);
    t.is(coverageMap.files().filter((x) => x.match(/[/\\]ms[/\\]/)).length, 0);
  });
}
