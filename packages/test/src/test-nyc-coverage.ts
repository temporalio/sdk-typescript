import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Istanbul injector execute correctly in Worker', async (t) => {
    // Make it believe that NYC has been loaded
    (global as any).__coverage__ = {};

    const workflowCoverage = new WorkflowCoverage();

    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create(
      workflowCoverage.augmentWorkerOptions({
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
      })
    );
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));

    const successStringFileName = workflowCoverage.coverageMap.files().find((x) => x.match(/\/success-string\.js/));
    if (successStringFileName) {
      t.is(workflowCoverage.coverageMap.fileCoverageFor(successStringFileName).toSummary().lines.pct, 100);
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

    const workflowCoverageWorker = new WorkflowCoverage();
    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create(
      workflowCoverageWorker.augmentWorkerOptionsWithBundle({
        taskQueue,
        workflowBundle: { code },
      })
    );
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));

    console.log(workflowCoverageWorker.coverageMap.files());

    const successStringFileName = workflowCoverageWorker.coverageMap
      .files()
      .find((x) => x.match(/\/success-string\.js/));
    if (successStringFileName) {
      t.is(workflowCoverageWorker.coverageMap.fileCoverageFor(successStringFileName).toSummary().lines.pct, 100);
    } else t.fail();
  });

  test('Istanbul injector exclude non-user code', async (t) => {
    // Make it believe that NYC has been loaded
    (global as any).__coverage__ = {};

    const workflowCoverage = new WorkflowCoverage();

    const taskQueue = `${t.title}-${uuid4()}`;
    const worker = await Worker.create(
      workflowCoverage.augmentWorkerOptions({
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
      })
    );
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));

    // Only user code should be included in coverage
    t.is(workflowCoverage.coverageMap.files().filter((x) => x.match(/\/worker-interface.js/)).length, 0);
    t.is(workflowCoverage.coverageMap.files().filter((x) => x.match(/\/ms\//)).length, 0);
  });
}
