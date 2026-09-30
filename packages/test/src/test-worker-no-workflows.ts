import { defaultOptions } from './mock-native-worker';
import { helpers, makeTestFunction } from './helpers-integration';
import { runActivityInDifferentTaskQueue } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Worker functions when asked not to run Workflows', async (t) => {
  const { createWorker, executeWorkflow, taskQueue } = helpers(t);
  const activitiesTaskQueue = `${taskQueue}-activities`;
  const { activities } = defaultOptions;
  const workflowlessWorker = await createWorker({
    workflowBundle: undefined,
    taskQueue: activitiesTaskQueue,
    activities,
  });
  const normalWorker = await createWorker();
  const result = await normalWorker.runUntil(
    workflowlessWorker.runUntil(
      executeWorkflow(runActivityInDifferentTaskQueue, {
        args: [activitiesTaskQueue],
      })
    )
  );
  t.is(result, 'hi');
});
