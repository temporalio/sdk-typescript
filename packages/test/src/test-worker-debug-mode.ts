import { helpers, makeTestFunction } from './helpers-integration';
import { successString } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Worker works in debugMode', async (t) => {
  // To debug Workflows with this worker run the test with `ava debug` and add breakpoints to your Workflows
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({ debugMode: true });
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});
