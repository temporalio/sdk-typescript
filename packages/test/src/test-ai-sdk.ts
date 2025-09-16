/**
 * Test AI SDK integration with Temporal workflows
 */
import { openai } from '@ai-sdk/openai'
import { invokeModel, TemporalProvider } from '@temporalio/ai-sdk';
import { aiTestWorkflow } from './workflows/ai-sdk';
import { helpers, makeTestFunction } from './helpers-integration';

globalThis.AI_SDK_DEFAULT_PROVIDER = new TemporalProvider(openai)

const test = makeTestFunction({
  workflowsPath: require.resolve("./workflows/ai-sdk"),
});

test('AI model can be used within Temporal workflow', async (t) => {
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    activities: {
      invokeModel,
    },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(aiTestWorkflow, {
      args: ['What is the weather in Tokyo?'],
    });

    t.assert(result);
  });
});