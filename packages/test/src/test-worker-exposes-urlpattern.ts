import * as nodeUrl from 'node:url';
import { helpers, makeTestFunction } from './helpers-integration';
import { urlPatternFromImport, urlPatternGlobal } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

// URLPattern is only available on Node 23.8+
const hostHasURLPattern = (nodeUrl as { URLPattern?: unknown }).URLPattern !== undefined;
const testIfURLPattern = hostHasURLPattern ? test : test.skip;

testIfURLPattern('Worker runtime exposes URLPattern as a global', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const result = await worker.runUntil(
    executeWorkflow(urlPatternGlobal, {
      args: ['https://example.com/users/42'],
      workflowExecutionTimeout: '5s',
    })
  );
  t.is(result, '42');
});

testIfURLPattern('Worker runtime exposes URLPattern as overrided import of url', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const result = await worker.runUntil(
    executeWorkflow(urlPatternFromImport, {
      args: ['https://example.com/users/42'],
      workflowExecutionTimeout: '5s',
    })
  );
  t.is(result, '42');
});
