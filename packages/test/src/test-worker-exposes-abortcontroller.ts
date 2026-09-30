import { helpers, makeTestFunction } from './helpers-integration';
import { abortController } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test(`Worker runtime exposes AbortController as a global`, async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const result = await worker.runUntil(
    executeWorkflow(abortController, {
      args: [],
      workflowExecutionTimeout: '5s',
    })
  );
  t.is(result, 'abort successful');
});
