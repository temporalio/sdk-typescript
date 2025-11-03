/**
 * Test AI SDK integration with Temporal workflows
 */
import { LanguageModelV2Content, LanguageModelV2FinishReason } from '@ai-sdk/provider';
import { openai } from '@ai-sdk/openai'
import { AiSDKPlugin, ModelGenerator, ModelResponse, TestProvider } from '@temporalio/ai-sdk';
import { temporal } from '@temporalio/proto';
import { helloWorldAgent, toolsWorkflow } from './workflows/ai-sdk';
import { helpers, makeTestFunction } from './helpers-integration';
import { getWeather} from './activities/ai-sdk';
import EventType = temporal.api.enums.v1.EventType;

const remoteTests = !!process.env.AI_SDK_REMOTE_TESTS;

function contentResponse(content: LanguageModelV2Content[], finishReason: LanguageModelV2FinishReason = "stop"): ModelResponse {
  return {
    content,
    finishReason,
    usage:{
      inputTokens:undefined,
      outputTokens:undefined,
      totalTokens:undefined
    },
    warnings:[]
  }
}

function textResponse(content: string): ModelResponse {
  return contentResponse([
      {
        type: "text",
        text: content
      }
    ])
}

function* helloWorkflowGenerator(): Generator<ModelResponse> {
  yield textResponse("Test Haiku")
}

function* toolsWorkflowGenerator(): Generator<ModelResponse> {
  yield contentResponse([
      {
        type: "tool-call",
        toolCallId: "call_yY3nlDwH5BQSJo63qC61L4ZB",
        toolName: "getWeather",
        input: '{"location":"Tokyo"}',
      },
    ], "tool-calls");
  yield textResponse("Test weather result");
}

function testGeneratorFactory(testName: string): Generator<ModelResponse> {
  switch (testName) {
    case "HelloWorkflow":
      return helloWorkflowGenerator()
    case "ToolsWorkflow":
      return toolsWorkflowGenerator()
  }
  throw new Error("Unrecognized model prompt")
}
const testProvider = new TestProvider(new ModelGenerator(testGeneratorFactory));

const test = makeTestFunction({
  workflowsPath: require.resolve("./workflows/ai-sdk"),
});

test('Hello world agent responds in haikus', async (t) => {
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [new AiSDKPlugin(remoteTests ? openai : testProvider)]
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(helloWorldAgent, {
      args: ['Tell me about recursion in programming.'],
      workflowExecutionTimeout: '30 seconds'
    });

    t.assert(result);
    if (!remoteTests) {
      t.is("Test Haiku", result);
    }
  });
});

test('Tools workflow can use AI tools', async (t) => {
  t.timeout(120 * 1000);
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [new AiSDKPlugin(remoteTests ? openai : testProvider)],
    activities: {
      getWeather
    },
  });
  console.log("Reuse context: ", worker.options.reuseV8Context)
  await worker.runUntil(async () => {
    const handle = await startWorkflow(toolsWorkflow, {
      args: ['What is the weather in Tokyo?'],
      workflowExecutionTimeout: '10 seconds'
    });

    const result = await handle.result();

    t.assert(result);
    if (!remoteTests) {
      t.is("Test weather result", result);
      
      // Check that activities were scheduled
      const { events } = await handle.fetchHistory();
      console.log("Events:", events);
      const activityCompletedEvents = events?.filter(e => 
        e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
      ) ?? [];
      
      // Should have at least 2 events: invokeModel and getWeather
      t.assert(activityCompletedEvents.length >= 2, 
        `Expected at least 2 activity completions, got ${activityCompletedEvents.length}`);

      // Check that getWeather activity was called
      const activityTypes = activityCompletedEvents.map(e =>
        e?.activityTaskScheduledEventAttributes?.activityType?.name
      );
      t.assert(activityTypes.includes('getWeather'),
        'getWeather activity should have been called');
    }
  });
});