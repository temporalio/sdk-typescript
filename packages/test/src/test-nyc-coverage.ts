import * as libCoverage from 'istanbul-lib-coverage';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';
import { helpers, makeTestFunction } from './helpers-integration';
import { successString } from './workflows';

declare global {
  var __coverage__: libCoverage.CoverageMapData;
}

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Istanbul injector execute correctly in Worker', async (t) => {
  // Make it believe that NYC has been loaded
  (global as any).__coverage__ = {};

  const { executeWorkflow, taskQueue } = helpers(t);
  const workflowCoverage = new WorkflowCoverage();
  const worker = await Worker.create({
    ...workflowCoverage.augmentWorkerOptions({
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
    }),
    connection: t.context.env.nativeConnection,
    namespace: t.context.env.client.options.namespace,
  });
  await worker.runUntil(executeWorkflow(successString));

  workflowCoverage.mergeIntoGlobalCoverage();
  const coverageMap = libCoverage.createCoverageMap(global.__coverage__);

  const successStringFileName = coverageMap.files().find((x) => x.match(/[/\\]success-string\.js/));
  if (successStringFileName) {
    t.is(coverageMap.fileCoverageFor(successStringFileName).toSummary().lines.pct, 100);
  } else t.fail();
});

test('Istanbul injector execute correctly in Bundler', async (t) => {
  const workflowCoverageBundler = new WorkflowCoverage();
  const { code } = await bundleWorkflowCode(
    workflowCoverageBundler.augmentBundleOptions({
      workflowsPath: require.resolve('./workflows'),
    })
  );

  // Make it believe that NYC has been loaded
  (global as any).__coverage__ = {};

  const { executeWorkflow, taskQueue } = helpers(t);
  const workflowCoverageWorker = new WorkflowCoverage();
  const worker = await Worker.create({
    ...workflowCoverageWorker.augmentWorkerOptionsWithBundle({
      taskQueue,
      workflowBundle: { code },
    }),
    connection: t.context.env.nativeConnection,
    namespace: t.context.env.client.options.namespace,
  });
  await worker.runUntil(executeWorkflow(successString));

  workflowCoverageBundler.mergeIntoGlobalCoverage();
  workflowCoverageWorker.mergeIntoGlobalCoverage();
  const coverageMap = libCoverage.createCoverageMap(global.__coverage__);
  const successStringFileName = coverageMap.files().find((x) => x.match(/[/\\]success-string\.js/));
  if (successStringFileName) {
    t.is(coverageMap.fileCoverageFor(successStringFileName).toSummary().lines.pct, 100);
  } else t.fail();
});

test('Istanbul injector exclude non-user code', async (t) => {
  // Make it believe that NYC has been loaded
  (global as any).__coverage__ = {};

  const { executeWorkflow, taskQueue } = helpers(t);
  const workflowCoverage = new WorkflowCoverage();
  const worker = await Worker.create({
    ...workflowCoverage.augmentWorkerOptions({
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
    }),
    connection: t.context.env.nativeConnection,
    namespace: t.context.env.client.options.namespace,
  });
  await worker.runUntil(executeWorkflow(successString));

  workflowCoverage.mergeIntoGlobalCoverage();
  const coverageMap = libCoverage.createCoverageMap(global.__coverage__);

  // Only user code should be included in coverage
  t.is(coverageMap.files().filter((x) => x.match(/[/\\]worker-interface\.js/)).length, 0);
  t.is(coverageMap.files().filter((x) => x.match(/[/\\]ms[/\\]/)).length, 0);
});
