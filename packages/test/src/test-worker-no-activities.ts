import { helpers, makeTestFunction } from './helpers-integration';
import { successString } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Worker functions when asked not to run Activities', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});
