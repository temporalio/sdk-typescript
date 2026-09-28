import { helpers, makeTestFunction } from './helpers-integration';
import { textEncoderDecoder, textEncoderDecoderFromImport } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Worker runtime exposes TextEncoder and TextDecoder as globals', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const result = await worker.runUntil(
    executeWorkflow(textEncoderDecoder, {
      args: ['a string that will be encoded and decoded'],
      workflowExecutionTimeout: '5s',
    })
  );
  t.is(result, 'a string that will be encoded and decoded');
});

test('Worker runtime exposes TextEncoder and TextDecoder as overrided import of util', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const result = await worker.runUntil(
    executeWorkflow(textEncoderDecoderFromImport, {
      args: ['a string that will be encoded and decoded'],
      workflowExecutionTimeout: '5s',
    })
  );
  t.is(result, 'a string that will be encoded and decoded');
});
