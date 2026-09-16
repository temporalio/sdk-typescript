/** Workflow information tests that depend on local visibility consistency and ordering. */
import { setTimeout as setTimeoutPromise } from 'timers/promises';
import { completableWorkflow } from './integration-workflows-common';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: require.resolve('./integration-workflows-common'),
});

test('Count workflow executions', async (t) => {
  const { taskQueue, createWorker, executeWorkflow, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const client = t.context.env.client;

  await worker.runUntil(async () => {
    await Promise.all([
      // Run 2 workflows that will never complete...
      startWorkflow(completableWorkflow, { args: [false] }),
      startWorkflow(completableWorkflow, { args: [false] }),

      // ... and 3 workflows that will complete
      executeWorkflow(completableWorkflow, { args: [true] }),
      executeWorkflow(completableWorkflow, { args: [true] }),
      executeWorkflow(completableWorkflow, { args: [true] }),
    ]);
  });

  // FIXME: Find a better way to wait for visibility to stabilize
  await setTimeoutPromise(1000);

  const actualTotal = await client.workflow.count(`TaskQueue = '${taskQueue}'`);
  t.deepEqual(actualTotal, { count: 5, groups: [] });

  const actualByExecutionStatus = await client.workflow.count(`TaskQueue = '${taskQueue}' GROUP BY ExecutionStatus`);
  t.deepEqual(actualByExecutionStatus, {
    count: 5,
    groups: [
      { count: 2, groupValues: [['Running']] },
      { count: 3, groupValues: [['Completed']] },
    ],
  });
});
