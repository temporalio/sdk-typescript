/**
 * Test AI SDK integration with Temporal workflows
 */
import { openai } from '@ai-sdk/openai'
import { invokeModel, TemporalProvider, TestProvider } from '@temporalio/ai-sdk';
import { temporal } from '@temporalio/proto';
import { helloWorldAgent, toolsWorkflow } from './workflows/ai-sdk';
import { helpers, makeTestFunction } from './helpers-integration';
import { getWeather} from './activities/ai-sdk';
import EventType = temporal.api.enums.v1.EventType;

const remoteTests = !!process.env.AI_SDK_REMOTE_TESTS;

function testContent(prompt: string): string {
  switch (prompt) {
    case "Tell me about recursion in programming.":
      return "Test Haiku"
    case "What is the weather in Tokyo?":
      return "Test weather result"
  }
  throw new Error("Unrecognized model prompt")
}

const testProvider = new TestProvider(async prompt => {
  const content = testContent(prompt)
  return {
    content:[
      {
        type: "text",
        text: content
      }
    ],
    finishReason:"stop",
    usage:{
      inputTokens:undefined,
      outputTokens:undefined,
      totalTokens:undefined
    },
    warnings:[]
  }
})

globalThis.AI_SDK_DEFAULT_PROVIDER = new TemporalProvider(remoteTests ? openai : testProvider)

const test = makeTestFunction({
  workflowsPath: require.resolve("./workflows/ai-sdk"),
});

test('Hello world agent responds in haikus', async (t) => {
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    activities: {
      invokeModel,
    },
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
    activities: {
      invokeModel,
      getWeather
    },
    reuseV8Context: false
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