import { v4 as uuid } from 'uuid';
import fetch from 'node-fetch';
import test from 'ava';
import { Runtime, Worker } from '@temporalio/worker';
import { getRandomPort, TestWorkflowEnvironment } from './helpers';
import * as activities from './activities';
import * as workflows from './workflows';

test.serial('Can run autoscaling polling worker', async (t) => {
  const port = await getRandomPort();
  Runtime.install({
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: `127.0.0.1:${port}`,
        },
      },
    },
  });
  const localEnv = await TestWorkflowEnvironment.createLocal();

  try {
    const taskQueue = `autoscale-pollers-${uuid()}`;
    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      connection: localEnv.nativeConnection,
      taskQueue,
      workflowTaskPollerBehavior: {
        type: 'autoscaling',
        initial: 2,
      },
      activityTaskPollerBehavior: {
        type: 'autoscaling',
        initial: 2,
      },
    });
    const workerPromise = worker.run();

    // Give pollers a beat to start
    await new Promise((resolve) => setTimeout(resolve, 300));

    const resp = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metricsText = await resp.text();
    const metricsLines = metricsText.split('\n');

    const matches = metricsLines.filter((l) => l.includes('temporal_num_pollers'));
    const activity_pollers = matches.filter((l) => l.includes('activity_task'));
    t.is(activity_pollers.length, 1, 'Should have exactly one activity poller metric');
    t.true(activity_pollers[0].endsWith('2'), 'Activity poller count should be 2');
    const workflow_pollers = matches.filter((l) => l.includes('workflow_task') && l.includes(taskQueue));
    t.is(workflow_pollers.length, 2, 'Should have exactly two workflow poller metrics (sticky and non-sticky)');

    // There's sticky & non-sticky pollers, and they may have a count of 1 or 2 depending on
    // initialization timing.
    t.true(
      workflow_pollers[0].endsWith('2') || workflow_pollers[0].endsWith('1'),
      'First workflow poller count should be 1 or 2'
    );
    t.true(
      workflow_pollers[1].endsWith('2') || workflow_pollers[1].endsWith('1'),
      'Second workflow poller count should be 1 or 2'
    );

    const workflowPromises = Array(20)
      .fill(0)
      .map(async (_) => {
        const handle = await localEnv.client.workflow.start(workflows.waitOnSignalThenActivity, {
          taskQueue,
          workflowId: `resource-based-${uuid()}`,
        });
        await handle.signal('my-signal', 'finish');
        return handle.result();
      });

    await Promise.all(workflowPromises);
    worker.shutdown();
    await workerPromise;
    t.pass();
  } finally {
    await localEnv.teardown();
  }
});
