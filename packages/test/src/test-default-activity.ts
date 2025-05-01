import * as activities from './activities/default-and-defined';
import { helpers, makeTestFunction } from './helpers-integration';
import { workflowWithMaybeDefinedActivity } from './workflows/default-activity-wf';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows/default-activity-wf') });

test('Uses default activity if no matching activity exists', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities,
  });

  await worker.runUntil(async () => {
    const activityArgs = ['test', 'args'];
    const res = await executeWorkflow(workflowWithMaybeDefinedActivity, {
      args: [false, activityArgs],
    });
    t.deepEqual(res, { name: 'default', activityName: 'nonExistentActivity', args: activityArgs });
  });
});

test('Does not use default activity if matching activity exists', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities,
  });

  await worker.runUntil(async () => {
    const activityArgs = ['test', 'args'];
    const res = await executeWorkflow(workflowWithMaybeDefinedActivity, {
      args: [true, activityArgs],
    });
    t.deepEqual(res, { name: 'definedActivity', args: activityArgs });
  });
});
