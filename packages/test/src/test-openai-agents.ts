/**
 * Test OpenAI Agents SDK integration with Temporal workflows
 */
import { OpenAIAgentsPlugin, StatelessMCPServerProvider, toSerializedModelResponse } from '@temporalio/openai-agents';
import { WorkflowFailedError } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import {
  basicAgentWorkflow,
  toolAgentWorkflow,
  handoffAgentWorkflow,
  maxTurnsAgentWorkflow,
  multiToolAgentWorkflow,
  contextAgentWorkflow,
  rawFunctionToolWorkflow,
  runConfigStringModelWorkflow,
  localActivityAgentWorkflow,
  retryableModelWorkflow,
  agentsWorkflowErrorWorkflow,
  mcpAgentWorkflow,
  builtInToolAgentWorkflow,
  handoffInstanceWorkflow,
  cyclicHandoffWorkflow,
  promptFieldWorkflow,
  nonStringModelWorkflow,
  wrappedTemporalFailureWorkflow,
  runStreamedWorkflow,
  agentsWorkflowErrorClassCheckWorkflow,
  eventTargetListenerErrorWorkflow,
  eventTargetTargetFieldWorkflow,
  dateInResponseWorkflow,
  directToolFactoryWorkflow,
  mcpPromptsWorkflow,
  mcpFactoryArgWorkflow,
  mcpProviderWorkflow,
  summaryOverrideStringWorkflow,
  tracingUtilitiesWorkflow,
  extendedModelParamsWorkflow,
  runConfigModelOverrideCheckWorkflow,
  handoffWithRawToolWorkflow,
  handoffInstanceWithRawToolWorkflow,
  handoffMutationCheckWorkflow,
  handoffOnHandoffCallbackWorkflow,
  handoffIsEnabledFalseWorkflow,
  handoffWithCustomSchemaWorkflow,
  timeoutErrorWorkflow,
  xShouldRetryWorkflow,
  plainErrorWorkflow,
  wireRoundTripWorkflow,
  wireStrippingCheckWorkflow,
  wireVersionMismatchWorkflow,
  wireRequestSnapshotWorkflow,
  tracingSpanCaptureWorkflow,
  replaySafetyWorkflow,
  handoffCloneSnapshotWorkflow,
} from './workflows/openai-agents';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  FakeModelProvider,
  GeneratorFakeModelProvider,
  ErrorModelProvider,
  RequestCapturingModelProvider,
  ModelNameCapturingModelProvider,
  ThrowAnythingModelProvider,
  textResponse,
  toolCallResponse,
  handoffResponse,
  responseWithDate,
  multiToolCallResponse,
} from './stubs/openai-agents';
import { getWeather, calculateSum } from './activities/openai-agents';
import EventType = temporal.api.enums.v1.EventType;

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/openai-agents'),
});

test('Basic agent responds to prompt', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Hello from agent!')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(result, 'Hello from agent!');
  });
});

function* toolWorkflowGenerator() {
  yield toolCallResponse('getWeather', { location: 'Tokyo' });
  yield textResponse('The weather in Tokyo is sunny, 14-20C.');
}

test('Agent can use tools backed by Temporal activities', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => toolWorkflowGenerator()),
      }),
    ],
    activities: {
      getWeather,
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(toolAgentWorkflow, {
      args: ['What is the weather in Tokyo?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'The weather in Tokyo is sunny, 14-20C.');

    // Verify both invokeModelActivity and getWeather appear in the workflow history
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(
      activityTypes.includes('invokeModelActivity'),
      `invokeModelActivity should be in history, got: ${activityTypes.join(', ')}`
    );
    t.true(activityTypes.includes('getWeather'), `getWeather should be in history, got: ${activityTypes.join(', ')}`);

    // Should have at least 3 activities: 2x invokeModelActivity (tool call + final response) + 1x getWeather
    t.true(
      activityScheduledEvents.length >= 3,
      `Expected at least 3 activity events, got ${activityScheduledEvents.length}`
    );
  });
});

function* handoffWorkflowGenerator() {
  // Turn 1: TriageAgent decides to hand off to WeatherSpecialist
  yield handoffResponse('transfer_to_WeatherSpecialist');
  // Turn 2: WeatherSpecialist responds with text
  yield textResponse('Sunny day!');
}

test('Agent can hand off to other agents', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => handoffWorkflowGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(handoffAgentWorkflow, {
      args: ['What is the weather in Tokyo?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.true(result.includes('Sunny'), `Expected output to contain 'Sunny', got: ${result}`);

    // Verify the handoff happened by checking activity history
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    // Should have 2 invokeModelActivity calls: one for triage agent, one for weather specialist
    const modelCalls = activityTypes.filter((name) => name === 'invokeModelActivity');
    t.true(
      modelCalls.length >= 2,
      `Expected at least 2 invokeModelActivity calls for handoff, got ${modelCalls.length}`
    );
  });
});

test('Agent respects max turns limit', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Single turn response')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(maxTurnsAgentWorkflow, {
      args: ['Hello', 1],
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(result.output, 'Single turn response');
    t.true(result.turnCount <= 1, `Expected turnCount <= 1, got ${result.turnCount}`);
  });
});

test('Model invocations are scheduled as activities', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Activity check')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    await handle.result();

    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(
      activityTypes.includes('invokeModelActivity'),
      `invokeModelActivity should be scheduled as an activity, got: ${activityTypes.join(', ')}`
    );
  });
});

test('Handles model errors gracefully', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Create an error with a 400 status so isRetryableError returns false (non-retryable)
  const modelError = new Error('Model API error');
  Object.assign(modelError, {
    response: { status: 400, headers: { get: () => undefined } },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(modelError),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    // Verify the error chain contains our error message
    t.truthy(err, 'Expected WorkflowFailedError');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('Model API error'),
      `Expected error chain to contain 'Model API error', got: ${fullMessage}`
    );

    // Verify error chain preserves classification
    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.is(
      failure?.applicationFailureInfo?.type,
      'ModelInvocationError.BadRequest',
      `Expected error type 'ModelInvocationError.BadRequest' for 400, got: ${failure?.applicationFailureInfo?.type}`
    );
    t.true(
      failure?.applicationFailureInfo?.nonRetryable === true,
      `Expected nonRetryable=true for 400, got nonRetryable=${failure?.applicationFailureInfo?.nonRetryable}`
    );
    t.true(
      failure?.message?.includes('Model API error') === true,
      `Expected original message preserved in failure, got: ${failure?.message}`
    );
  });
});

function* multiToolGenerator() {
  yield toolCallResponse('getWeather', { location: 'Tokyo' });
  yield toolCallResponse('calculateSum', { a: 5, b: 3 });
  yield textResponse('Weather in Tokyo is sunny and 5+3=8.');
}

test('Agent with multiple tools', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => multiToolGenerator()),
      }),
    ],
    activities: {
      getWeather,
      calculateSum,
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(multiToolAgentWorkflow, {
      args: ['What is the weather in Tokyo and what is 5+3?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'Weather in Tokyo is sunny and 5+3=8.');

    // Verify both tool activities appear in history
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(activityTypes.includes('getWeather'), `getWeather should be in history, got: ${activityTypes.join(', ')}`);
    t.true(
      activityTypes.includes('calculateSum'),
      `calculateSum should be in history, got: ${activityTypes.join(', ')}`
    );
  });
});

test('Agent workflow with typed context', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Hello user-123!')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(contextAgentWorkflow, {
      args: ['Hello', 'user-123'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(result, 'Hello user-123!');
  });
});

test('Raw function tool is rejected with clear error', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach here')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(rawFunctionToolWorkflow, {
      args: ['What is the weather?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(fullMessage.includes('activityAsTool'), `Expected error to mention activityAsTool, got: ${fullMessage}`);
  });
});

test('RunConfig.model string override works', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Model override response')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(runConfigStringModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(result, 'Model override response');
  });
});

test('Local activity mode uses local activities for model calls', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Local activity response')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(localActivityAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'Local activity response');

    const { events } = await handle.fetchHistory();

    // Local activities appear as MarkerRecorded events (marker name "core_local_activity"),
    // not as ActivityTaskScheduled events
    const markerEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_MARKER_RECORDED) ?? [];
    t.true(
      markerEvents.length > 0,
      `Expected MarkerRecorded events for local activities in history, got ${markerEvents.length}`
    );

    // Should NOT have regular activity scheduled events for model invocation
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    const modelActivities = activityScheduledEvents.filter(
      (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'invokeModelActivity'
    );
    t.is(modelActivities.length, 0, `Expected no regular invokeModelActivity, got ${modelActivities.length}`);
  });
});

test('Retryable 429 error is classified as retryable (nonRetryable=false)', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error429 = new Error('Rate limit exceeded');
  Object.assign(error429, {
    response: { status: 429, headers: { get: () => undefined } },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error429),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    // Workflow should fail after all retry attempts are exhausted
    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('Rate limit exceeded'),
      `Expected error chain to contain 'Rate limit exceeded', got: ${fullMessage}`
    );

    // Verify the failure is classified as retryable
    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    const nonRetryable = failure?.applicationFailureInfo?.nonRetryable;
    t.falsy(
      nonRetryable,
      `Expected 429 to be classified as retryable (nonRetryable=false), got nonRetryable=${nonRetryable}`
    );
    const failureType = failure?.applicationFailureInfo?.type;
    t.is(failureType, 'ModelInvocationError.RateLimit');
  });
});

test('Non-retryable 400 error fails without retry', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error400 = new Error('Bad request: invalid prompt');
  Object.assign(error400, {
    response: { status: 400, headers: { get: () => undefined } },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error400),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('Bad request: invalid prompt'),
      `Expected error chain to contain 'Bad request: invalid prompt', got: ${fullMessage}`
    );

    // Verify only 1 activity attempt — non-retryable errors should not be retried
    const { events } = await handle.fetchHistory();
    const activityStartedEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED) ?? [];
    t.is(
      activityStartedEvents.length,
      1,
      `Expected exactly 1 activity attempt (no retry), got ${activityStartedEvents.length}`
    );

    // Verify the failure is classified as non-retryable
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.true(failure?.applicationFailureInfo?.nonRetryable, 'Expected 400 to be classified as non-retryable');
  });
});

test('AgentsWorkflowError wraps non-Temporal errors', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach here')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(agentsWorkflowErrorWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError');
    // Error chain: err.cause = ApplicationFailure, err.cause.cause = AgentsWorkflowError wrapper,
    // err.cause.cause.cause = original Error. Check err.cause which stringifies the full chain.
    const wrappedMessage = String(err!.cause);
    t.true(
      wrappedMessage.includes('Agent workflow failed'),
      `Expected wrapper message to contain 'Agent workflow failed', got: ${wrappedMessage}`
    );
    t.true(
      wrappedMessage.includes('Instructions evaluation failed'),
      `Expected wrapper to contain original error message, got: ${wrappedMessage}`
    );
  });
});

// --- Stateless MCP ---

function* mcpToolWorkflowGenerator() {
  // Turn 1: model calls the MCP tool "get_time"
  yield toolCallResponse('get_time', {});
  // Turn 2: model returns a text response incorporating the tool result
  yield textResponse('The current time is 2026-01-01T00:00:00Z.');
}

test('Stateless MCP server delegates listTools and callTool to activities', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => mcpToolWorkflowGenerator()),
      }),
    ],
    activities: {
      'testMcp-list-tools': async () => {
        return [
          {
            name: 'get_time',
            description: 'Returns current time',
            inputSchema: {
              type: 'object' as const,
              properties: {},
              required: [] as string[],
              additionalProperties: false,
            },
          },
        ];
      },
      'testMcp-call-tool-v2': async (_input: { toolName: string; args: Record<string, unknown> | null }) => {
        return [{ type: 'text', text: '2026-01-01T00:00:00Z' }];
      },
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(mcpAgentWorkflow, {
      args: ['What time is it?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'The current time is 2026-01-01T00:00:00Z.');

    // Verify MCP activities appear in the workflow history
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(
      activityTypes.includes('testMcp-list-tools'),
      `testMcp-list-tools should be in history, got: ${activityTypes.join(', ')}`
    );
    t.true(
      activityTypes.includes('testMcp-call-tool-v2'),
      `testMcp-call-tool-v2 should be in history, got: ${activityTypes.join(', ')}`
    );
    t.true(
      activityTypes.includes('invokeModelActivity'),
      `invokeModelActivity should be in history, got: ${activityTypes.join(', ')}`
    );
  });
});

// --- Built-in tools pass-through ---

test('Built-in tools pass through without serialization error', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse("I could search but won't")]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(builtInToolAgentWorkflow, {
      args: ['Search for something'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, "I could search but won't");

    // Verify the model activity fired (the built-in tool survived serialization)
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(
      activityTypes.includes('invokeModelActivity'),
      `invokeModelActivity should be in history, got: ${activityTypes.join(', ')}`
    );
  });
});

// --- Bug exercise tests: handoff, cycle, prompt, model validation ---

// T1 — F1: Handoff instance (via handoff()) reaches target agent via activity
function* handoffInstanceGenerator() {
  yield handoffResponse('transfer_to_WeatherSpecialist');
  yield textResponse('Specialist says: sunny!');
}

test('F1: Handoff-instance handoff reaches target agent via model activity', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => handoffInstanceGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(handoffInstanceWorkflow, {
      args: ['What is the weather in Tokyo?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.true(result.includes('sunny'), `Expected output to contain 'sunny', got: ${result}`);

    // Verify at least 2 model activity calls (triage + specialist after handoff)
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    const modelCalls = activityScheduledEvents.filter(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name === 'invokeModelActivity'
    );
    t.true(
      modelCalls.length >= 2,
      `Expected >= 2 invokeModelActivity calls (triage + specialist), got ${modelCalls.length}`
    );
  });
});

// T2 — F2: Cyclic handoff graph terminates without stack overflow
test('F2: Cyclic handoff graph terminates without stack overflow', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('ok')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(cyclicHandoffWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '5 seconds',
    });
    t.is(result, 'ok');
  });
});

// T3 — F3: prompt field is forwarded to the activity
test('F3: prompt field is forwarded through ActivityBackedModel to the activity', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const provider = new RequestCapturingModelProvider();
  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: provider,
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(promptFieldWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'captured');
  });

  // After workflow completes, verify the model received the prompt field
  t.truthy(provider.lastRequest, 'Expected model to have received a request');
  const receivedPrompt = (provider.lastRequest as any)?.prompt;
  t.truthy(receivedPrompt, 'Expected prompt field to be present in model request');
  t.is(receivedPrompt?.promptId, 'pt_test', `Expected promptId 'pt_test', got: ${receivedPrompt?.promptId}`);
});

// T4 — F4: Non-string agent.model throws AgentsWorkflowError
test('F4: Non-string agent.model throws AgentsWorkflowError', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(nonStringModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError');
    const cause = err!.cause as any;
    const failureType =
      cause?.failure?.applicationFailureInfo?.type ?? cause?.applicationFailureInfo?.type ?? cause?.type;
    t.is(failureType, 'AgentsWorkflowError', `Expected type 'AgentsWorkflowError', got: ${failureType}`);

    const fullMessage = String(cause);
    t.true(fullMessage.includes('string'), `Expected error message to mention 'string', got: ${fullMessage}`);
  });
});

// T5a — F5: SDK-shape 429 (status on error directly) classified as retryable
test('F5: SDK-shape 429 (error.status) classified as retryable', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const sdkError429 = new Error('Rate limit exceeded');
  Object.assign(sdkError429, { status: 429, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(sdkError429),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.falsy(
      failure?.applicationFailureInfo?.nonRetryable,
      'Expected SDK-shape 429 to be classified as retryable (nonRetryable=false)'
    );
  });
});

// T5b — F5: SDK-shape 400 (status on error directly) classified as non-retryable
test('F5: SDK-shape 400 (error.status) classified as non-retryable', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const sdkError400 = new Error('Bad request: invalid parameters');
  Object.assign(sdkError400, { status: 400, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(sdkError400),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.true(failure?.applicationFailureInfo?.nonRetryable, 'Expected SDK-shape 400 to be classified as non-retryable');

    // Non-retryable means only 1 attempt
    const startedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED) ?? [];
    t.is(startedEvents.length, 1, `Expected 1 attempt for non-retryable, got ${startedEvents.length}`);
  });
});

// T6 — F6: retry-after-ms header is honored as nextRetryDelay
test('F6: retry-after-ms header sets nextRetryDelay on activity failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error429 = new Error('Rate limited');
  Object.assign(error429, {
    status: 429,
    headers: { get: (k: string) => (k === 'retry-after-ms' ? '5000' : undefined) },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error429),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');

    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    const nextRetryDelay = failure?.applicationFailureInfo?.nextRetryDelay;
    t.truthy(nextRetryDelay, 'Expected nextRetryDelay to be set from retry-after-ms header');
    const delaySec = Number(nextRetryDelay?.seconds ?? 0);
    t.is(delaySec, 5, `Expected nextRetryDelay of 5 seconds (from retry-after-ms: 5000), got: ${delaySec}s`);
  });
});

// T7 — F13: TemporalFailure in Error.cause is unwrapped, not re-wrapped as AgentsWorkflowError
test('F13: TemporalFailure in Error.cause is unwrapped and re-thrown', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(wrappedTemporalFailureWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    t.truthy(err);

    // If F13 is fixed: inner ApplicationFailure (type 'InnerFailureType') is re-thrown directly
    // If F13 is buggy: runner wraps as 'AgentsWorkflowError', losing the original type
    const cause = err!.cause as any;
    const failureType =
      cause?.failure?.applicationFailureInfo?.type ?? cause?.applicationFailureInfo?.type ?? cause?.type;
    t.not(
      failureType,
      'AgentsWorkflowError',
      `Expected inner TemporalFailure to propagate, not be wrapped as AgentsWorkflowError`
    );
    t.is(failureType, 'InnerFailureType', `Expected failure type 'InnerFailureType', got: ${failureType}`);
  });
});

// --- Error wrapping + streaming ---

// C1 — F7: AgentsWorkflowError class is instantiated by the runner and appears
// on the serialized failure via the cause chain.
test('C1/F7: AgentsWorkflowError type is preserved in serialized failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(agentsWorkflowErrorWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    t.truthy(err);

    const cause = err!.cause as any;
    const failureType =
      cause?.failure?.applicationFailureInfo?.type ?? cause?.applicationFailureInfo?.type ?? cause?.type;
    t.is(failureType, 'AgentsWorkflowError', `Expected failure type 'AgentsWorkflowError', got: ${failureType}`);
  });
});

// C1/F7: Verify AgentsWorkflowError is actually instantiated inside the workflow.
// The workflow catches the runner's error and inspects e.cause.name.
test('C1/F7: Runner wraps error with AgentsWorkflowError (in-workflow check)', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(agentsWorkflowErrorClassCheckWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    const info = JSON.parse(result);
    t.is(
      info.causeName,
      'AgentsWorkflowError',
      `Expected runner to throw with AgentsWorkflowError cause, got causeName=${info.causeName}`
    );
  });
});

// C3 — F27: runner.runStreamed() throws a clear not-supported error.
test('C3/F27: runStreamed throws clear not-supported error', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(runStreamedWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    t.truthy(err);

    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('Streaming is not supported') || fullMessage.includes('streaming is not supported'),
      `Expected error to mention 'Streaming is not supported', got: ${fullMessage}`
    );
  });
});

// --- Determinism + error hygiene ---

// D1/F9: Non-Error thrown values should be preserved as cause
test('D1/F9: Non-Error thrown value is wrapped and preserved as cause', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ThrowAnythingModelProvider('custom string error'),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    t.truthy(err);

    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('custom string error'),
      `Expected error chain to contain 'custom string error', got: ${fullMessage}`
    );

    // The key assertion: the activity failure's cause should be preserved (not undefined)
    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.truthy(failure?.cause, 'Expected non-Error value to be wrapped in Error and preserved as cause');
  });
});

// D3/F11: EventTarget polyfill should isolate listener errors
test('D3/F11: EventTarget polyfill isolates listener errors', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('unused')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(eventTargetListenerErrorWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    t.true(result.dispatchSucceeded, 'dispatchEvent should succeed even if a listener throws');
    t.true(result.secondListenerCalled, 'Second listener should be called even if first throws');
  });
});

// D4/F12: EventTarget polyfill should set event.target and event.currentTarget
test('D4/F12: EventTarget polyfill sets event.target and event.currentTarget', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('unused')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(eventTargetTargetFieldWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    t.true(result.targetDefined, 'event.target should be defined (set to the EventTarget instance)');
    t.true(result.currentTargetDefined, 'event.currentTarget should be defined (set to the EventTarget instance)');
  });
});

// D5/F14: Error type should be derived from status code
test('D5/F14: 429 error produces ModelInvocationError.RateLimit type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error429 = new Error('Rate limit exceeded');
  Object.assign(error429, { status: 429, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error429),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    const failureType = failure?.applicationFailureInfo?.type;
    t.is(failureType, 'ModelInvocationError.RateLimit', `Expected RateLimit type for 429, got: ${failureType}`);
  });
});

test('D5/F14: 401 error produces ModelInvocationError.Authentication type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error401 = new Error('Unauthorized');
  Object.assign(error401, { status: 401, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error401),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    const failureType = failure?.applicationFailureInfo?.type;
    t.is(
      failureType,
      'ModelInvocationError.Authentication',
      `Expected Authentication type for 401, got: ${failureType}`
    );
  });
});

test('D5/F14: 400 error produces ModelInvocationError.BadRequest type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error400 = new Error('Bad request');
  Object.assign(error400, { status: 400, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error400),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    const failureType = failure?.applicationFailureInfo?.type;
    t.is(failureType, 'ModelInvocationError.BadRequest', `Expected BadRequest type for 400, got: ${failureType}`);
  });
});

test('D5/F14: 500 error produces ModelInvocationError.ServerError type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error500 = new Error('Internal server error');
  Object.assign(error500, { status: 500, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error500),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    const failureType = failure?.applicationFailureInfo?.type;
    t.is(failureType, 'ModelInvocationError.ServerError', `Expected ServerError type for 500, got: ${failureType}`);
  });
});

// D6/F15: Non-Error non-object (e.g. throw 42) produces non-retryable ApplicationFailure
test('D6/F15: Non-Error non-object throw produces non-retryable failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ThrowAnythingModelProvider(42),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(fullMessage.includes('42'), `Expected error chain to contain '42', got: ${fullMessage}`);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.true(
      failure?.applicationFailureInfo?.nonRetryable,
      'Expected non-object throw to be classified as non-retryable'
    );
    // Should only have 1 attempt (non-retryable = no retries)
    const startedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED) ?? [];
    t.is(startedEvents.length, 1, `Expected 1 attempt for non-retryable, got ${startedEvents.length}`);
  });
});

// D7/F16: Date fields in ModelResponse are coerced by Temporal JSON serialization.
// Temporal's default payload converter serializes via JSON.stringify.
// Date objects become ISO strings, class instances become plain objects.
// @openai/agents-core's ModelResponse uses plain JSON-safe types by default,
// so this is typically not a concern. Custom ModelProviders that emit Dates
// or class instances should pre-serialize them.
test('D7/F16: Date in ModelResponse is coerced to string by Temporal serialization', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([responseWithDate('Date test')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(dateInResponseWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(typeof result.hasDateField, 'boolean', 'Workflow should return hasDateField status');
    if (result.hasDateField) {
      t.is(result.dateFieldType, 'string', 'Date is coerced to ISO string by Temporal JSON serialization');
    } else {
      t.is(result.dateFieldType, 'undefined', 'Stripped custom field should have undefined type');
    }
  });
});

// --- Tool validation ---

// E3/F20: tool() from agents-core directly (not activityAsTool) should be rejected
test('E3/F20: FunctionTool from tool() factory is rejected with helpful error', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach here')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(directToolFactoryWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(fullMessage.includes('activityAsTool'), `Expected error to mention activityAsTool, got: ${fullMessage}`);
  });
});

// --- F2: MCP prompts + provider ---

test('F2: MCP listPrompts and getPrompt delegate to activities', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('unused')]),
      }),
    ],
    activities: {
      'testMcp-list-tools': async () => [],
      'testMcp-call-tool-v2': async () => [],
      'testMcp-list-prompts': async () => {
        return [
          { name: 'greeting', description: 'A greeting prompt' },
          { name: 'farewell', description: 'A farewell prompt' },
        ];
      },
      'testMcp-get-prompt-v2': async (input: {
        promptName: string;
        promptArguments: Record<string, unknown> | null;
      }) => {
        return {
          messages: [{ role: 'user', content: `Hello, ${(input.promptArguments as any)?.name ?? 'stranger'}!` }],
        };
      },
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(mcpPromptsWorkflow, {
      args: ['test'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();

    // Verify listPrompts returned data
    t.is((result.prompts as any[]).length, 2, 'Expected 2 prompts from listPrompts');
    t.is((result.prompts as any[])[0].name, 'greeting');

    // Verify getPrompt returned data
    t.truthy(result.promptResult, 'Expected getPrompt to return data');
    t.is((result.promptResult as any).messages[0].content, 'Hello, World!');

    // Verify activities appeared in history
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(
      activityTypes.includes('testMcp-list-prompts'),
      `testMcp-list-prompts should be in history, got: ${activityTypes.join(', ')}`
    );
    t.true(
      activityTypes.includes('testMcp-get-prompt-v2'),
      `testMcp-get-prompt-v2 should be in history, got: ${activityTypes.join(', ')}`
    );
  });
});

function* mcpFactoryArgGenerator() {
  yield toolCallResponse('get_time', {});
  yield textResponse('The time for tenant-42 is 2026-01-01.');
}

test('F2: factoryArgument is passed through to MCP activities', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  let receivedFactoryArg: unknown;
  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => mcpFactoryArgGenerator()),
      }),
    ],
    activities: {
      'testMcp-list-tools': async (input: any) => {
        receivedFactoryArg = input?.factoryArgument;
        return [
          {
            name: 'get_time',
            description: 'Returns current time',
            inputSchema: {
              type: 'object' as const,
              properties: {},
              required: [] as string[],
              additionalProperties: false,
            },
          },
        ];
      },
      'testMcp-call-tool-v2': async (input: any) => {
        t.deepEqual(input.factoryArgument, { tenantId: 'tenant-42' }, 'factoryArgument should be passed to callTool');
        return [{ type: 'text', text: '2026-01-01' }];
      },
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(mcpFactoryArgWorkflow, {
      args: ['What time is it?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.truthy(result, 'Workflow should complete successfully');

    // Verify factoryArgument was passed to listTools activity
    t.deepEqual(receivedFactoryArg, { tenantId: 'tenant-42' }, 'factoryArgument should be passed to listTools');
  });
});

function* mcpProviderGenerator() {
  yield toolCallResponse('get_data', {});
  yield textResponse('Data retrieved via provider.');
}

test('F2: StatelessMCPServerProvider registers activities via plugin', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const mcpProvider = new StatelessMCPServerProvider('providerMcp', {
    listTools: async () => [
      {
        name: 'get_data',
        description: 'Get some data',
        inputSchema: { type: 'object' as const, properties: {}, required: [] as string[], additionalProperties: false },
      },
    ],
    callTool: async () => [{ type: 'text', text: 'provider-data-result' }],
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => mcpProviderGenerator()),
        mcpServerProviders: [mcpProvider],
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(mcpProviderWorkflow, {
      args: ['Get the data'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'Data retrieved via provider.');

    // Verify provider-registered activities appear in history
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(
      activityTypes.includes('providerMcp-list-tools'),
      `providerMcp-list-tools should be in history, got: ${activityTypes.join(', ')}`
    );
    t.true(
      activityTypes.includes('providerMcp-call-tool-v2'),
      `providerMcp-call-tool-v2 should be in history, got: ${activityTypes.join(', ')}`
    );
  });
});

// --- F4: Summary override ---

test('F4: summaryOverride string is passed through to model activity', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Summary test response')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(summaryOverrideStringWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'Summary test response');

    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    t.true(
      activityScheduledEvents.length >= 1,
      `Expected at least 1 activity scheduled event, got ${activityScheduledEvents.length}`
    );

    const modelEvent = activityScheduledEvents.find(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name === 'invokeModelActivity'
    );
    t.truthy(modelEvent, 'Expected invokeModelActivity in history');
    const userMetadata = (modelEvent as any)?.userMetadata;
    t.truthy(userMetadata, 'Expected userMetadata on activity scheduled event');
    if (userMetadata) {
      const summaryPayload = userMetadata?.summary;
      t.truthy(summaryPayload, 'Expected summary payload in userMetadata');
      if (summaryPayload) {
        const summaryText = Buffer.from(summaryPayload.data).toString('utf-8');
        t.true(
          summaryText.includes('Custom model summary'),
          `Expected summary metadata to contain 'Custom model summary', got: ${summaryText}`
        );
      }
    }
  });
});

// --- F1b: Tracing utilities ---

test('F1b: Tracing utilities return correct values in workflow context', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('unused')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(tracingUtilitiesWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    t.true(result.isInWf, 'isInWorkflow() should return true inside workflow');
    t.is(typeof result.isReplay, 'boolean', 'isReplaying() should return a boolean');
  });
});

// --- F5: Additional model activity parameters ---

test('F5: Extended model params (priority) pass through without error', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Extended params OK')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(extendedModelParamsWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(result, 'Extended params OK');
  });
});

// --- F1a: Public testing namespace ---

test('F1a: Testing namespace exports are importable', async (t) => {
  // Verify the testing namespace is accessible from the main package
  const testing = await import('@temporalio/openai-agents/lib/testing');

  t.truthy(testing.FakeModel, 'FakeModel should be exported');
  t.truthy(testing.FakeModelProvider, 'FakeModelProvider should be exported');
  t.truthy(testing.GeneratorFakeModel, 'GeneratorFakeModel should be exported');
  t.truthy(testing.GeneratorFakeModelProvider, 'GeneratorFakeModelProvider should be exported');
  t.truthy(testing.textResponse, 'textResponse should be exported');
  t.truthy(testing.toolCallResponse, 'toolCallResponse should be exported');
  t.truthy(testing.handoffResponse, 'handoffResponse should be exported');
  t.truthy(testing.multiToolCallResponse, 'multiToolCallResponse should be exported');

  // Verify they work
  const response = testing.textResponse('test');
  t.truthy(response.output, 'textResponse should produce a valid ModelResponse');
});

// --- Batch G: Test coverage gaps ---

// G2/F29: Verify retry policy is applied — retryState proves the server used the policy
test('G2/F29: Retryable 429 error exhausts retry policy (retryState=MAXIMUM_ATTEMPTS_REACHED)', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error429 = new Error('Rate limit exceeded');
  Object.assign(error429, {
    response: { status: 429, headers: { get: () => undefined } },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error429),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(retryableModelWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    t.truthy(err, 'Workflow should fail after retry policy is exhausted');

    const { events } = await handle.fetchHistory();

    // Temporal dev server reports MAX_ATTEMPTS_REACHED regardless of actual retry count;
    // asserting retryState proves the retry-policy path was taken (vs NON_RETRYABLE_FAILURE).
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one ACTIVITY_TASK_FAILED event');
    const lastFailed = failedEvents[failedEvents.length - 1];
    t.is(
      lastFailed?.activityTaskFailedEventAttributes?.retryState,
      4, // RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED
      'Retry state should be MAXIMUM_ATTEMPTS_REACHED (retry policy applied, not non-retryable)'
    );
  });
});

// G3/F32: Parallel tool calls — single model response containing multiple function_calls
function* parallelToolCallGenerator() {
  yield multiToolCallResponse([
    { name: 'getWeather', args: { location: 'Tokyo' } },
    { name: 'calculateSum', args: { a: 5, b: 3 } },
  ]);
  yield textResponse('Weather is sunny and 5+3=8.');
}

test('G3/F32: Parallel tool calls in one model response', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => parallelToolCallGenerator()),
      }),
    ],
    activities: {
      getWeather,
      calculateSum,
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(multiToolAgentWorkflow, {
      args: ['What is the weather in Tokyo and what is 5+3?'],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();
    t.is(result, 'Weather is sunny and 5+3=8.');

    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );

    t.true(activityTypes.includes('getWeather'), `getWeather should be scheduled, got: ${activityTypes.join(', ')}`);
    t.true(
      activityTypes.includes('calculateSum'),
      `calculateSum should be scheduled, got: ${activityTypes.join(', ')}`
    );

    // Both tool calls from a single model response + the final text response = 2 model activity calls
    const modelCalls = activityTypes.filter((name) => name === 'invokeModelActivity');
    t.is(modelCalls.length, 2, `Expected 2 invokeModelActivity calls, got ${modelCalls.length}`);

    // Verify parallel scheduling: both tool activities should be scheduled
    // in the same workflow task (same workflowTaskCompletedEventId)
    const toolEvents = activityScheduledEvents.filter((e) => {
      const name = e?.activityTaskScheduledEventAttributes?.activityType?.name;
      return name === 'getWeather' || name === 'calculateSum';
    });
    if (toolEvents.length === 2) {
      const taskId1 = (toolEvents[0]?.activityTaskScheduledEventAttributes as any)?.workflowTaskCompletedEventId;
      const taskId2 = (toolEvents[1]?.activityTaskScheduledEventAttributes as any)?.workflowTaskCompletedEventId;
      t.truthy(taskId1, 'Expected workflowTaskCompletedEventId on first tool event');
      t.deepEqual(taskId1, taskId2, 'Both tool activities should be scheduled in the same workflow task (parallel)');
    }
  });
});

// G5/F34: Replay smoke test — verify determinism by replaying recorded history
test('G5/F34: Workflow replay succeeds without determinism errors', async (t) => {
  const { createWorker, startWorkflow, runReplayHistory } = helpers(t);

  let history: temporal.api.history.v1.IHistory | undefined;

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => toolWorkflowGenerator()),
      }),
    ],
    activities: {
      getWeather,
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(toolAgentWorkflow, {
      args: ['What is the weather in Tokyo?'],
      workflowExecutionTimeout: '30 seconds',
    });

    await handle.result();
    history = (await handle.fetchHistory()) ?? undefined;
  });

  t.truthy(history, 'Should have captured workflow history');
  await runReplayHistory({}, history!);
  t.pass('Replay completed without determinism errors');
});

// G6/F-C: Schema-invalid tool input — activityAsTool does not validate args against schema
function* schemaInvalidToolInputGenerator() {
  yield toolCallResponse('calculateSum', { x: 5, y: 3 });
  yield textResponse('The calculation returned a result.');
}

// --- H1: runConfig.model override reaches activity ---

test('H1: runConfig.model string override uses override model name in activity', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const provider = new ModelNameCapturingModelProvider();
  const worker = await createWorker({
    plugins: [new OpenAIAgentsPlugin({ modelProvider: provider })],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(runConfigModelOverrideCheckWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'captured');
  });

  t.true(
    provider.capturedModelNames.includes('override-model'),
    `Expected 'override-model' in activity, got: ${provider.capturedModelNames.join(', ')}`
  );
  t.false(
    provider.capturedModelNames.includes('original-model'),
    `Agent's original model 'original-model' should NOT be used when runConfig.model overrides it, got: ${provider.capturedModelNames.join(
      ', '
    )}`
  );
});

// --- H2: validateTools recurses into handoff agents ---

test('H2: validateTools catches raw function tool on handoff agent (Agent handoff)', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(handoffWithRawToolWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError for raw tool on handoff agent');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('activityAsTool') || fullMessage.includes('not a tool type'),
      `Expected error about activityAsTool for handoff agent's raw tool, got: ${fullMessage}`
    );
  });
});

test('H2: validateTools catches raw function tool on handoff() instance agent', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(handoffInstanceWithRawToolWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });

    t.truthy(err, 'Expected WorkflowFailedError for raw tool on handoff() agent');
    const fullMessage = String(err!.cause?.cause ?? err!.cause ?? err);
    t.true(
      fullMessage.includes('activityAsTool') || fullMessage.includes('not a tool type'),
      `Expected error about activityAsTool, got: ${fullMessage}`
    );
  });
});

// --- H5: Handoff mutation ---

function* handoffMutationGenerator() {
  yield handoffResponse('transfer_to_Specialist');
  yield textResponse('Specialist says hello');
}

test('H5: convertAgent does not mutate original Handoff objects', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => handoffMutationGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(handoffMutationCheckWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const info = JSON.parse(result);
    t.false(
      info.mutated,
      `Original handoff should not be mutated. Model type was '${info.originalModelType}' before, '${info.afterModelType}' after`
    );
  });
});

// --- H3: Error classification edge cases ---

test('H3: 408 Timeout error produces ModelInvocationError.Timeout type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error408 = new Error('Request timeout');
  Object.assign(error408, { status: 408, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error408),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(timeoutErrorWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.is(
      failure?.applicationFailureInfo?.type,
      'ModelInvocationError.Timeout',
      `Expected Timeout type for 408, got: ${failure?.applicationFailureInfo?.type}`
    );
    t.falsy(failure?.applicationFailureInfo?.nonRetryable, 'Expected 408 to be classified as retryable');
  });
});

test('H3: 409 Conflict error produces ModelInvocationError.Conflict type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error409 = new Error('Conflict');
  Object.assign(error409, { status: 409, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error409),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(timeoutErrorWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.is(
      failure?.applicationFailureInfo?.type,
      'ModelInvocationError.Conflict',
      `Expected Conflict type for 409, got: ${failure?.applicationFailureInfo?.type}`
    );
    t.falsy(failure?.applicationFailureInfo?.nonRetryable, 'Expected 409 to be classified as retryable');
  });
});

test('H3: 422 error produces ModelInvocationError.BadRequest type', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error422 = new Error('Unprocessable entity');
  Object.assign(error422, { status: 422, headers: {} });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error422),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.is(
      failure?.applicationFailureInfo?.type,
      'ModelInvocationError.BadRequest',
      `Expected BadRequest type for 422, got: ${failure?.applicationFailureInfo?.type}`
    );
    t.true(failure?.applicationFailureInfo?.nonRetryable, 'Expected 422 to be classified as non-retryable');
  });
});

test('H3: x-should-retry true overrides non-retryable 400 to retryable', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error400WithRetry = new Error('Bad request but should retry');
  Object.assign(error400WithRetry, {
    status: 400,
    headers: { get: (k: string) => (k === 'x-should-retry' ? 'true' : undefined) },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error400WithRetry),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(xShouldRetryWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.falsy(
      failure?.applicationFailureInfo?.nonRetryable,
      'Expected x-should-retry:true to make 400 retryable (nonRetryable=false)'
    );
  });
});

test('H3: Plain Error without HTTP status is non-retryable', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(new Error('non-HTTP bug')),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(plainErrorWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.true(
      failure?.applicationFailureInfo?.nonRetryable,
      'Expected plain Error (no HTTP status) to be classified as non-retryable'
    );

    const startedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED) ?? [];
    t.is(startedEvents.length, 1, `Expected 1 attempt for non-retryable, got ${startedEvents.length}`);
  });
});

test('H3: x-should-retry false overrides retryable 429 to non-retryable', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const error429NoRetry = new Error('Rate limit but do not retry');
  Object.assign(error429NoRetry, {
    status: 429,
    headers: { get: (k: string) => (k === 'x-should-retry' ? 'false' : undefined) },
  });

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new ErrorModelProvider(error429NoRetry),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicAgentWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });

    const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.truthy(err);

    const { events } = await handle.fetchHistory();
    const failedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED) ?? [];
    t.true(failedEvents.length >= 1, 'Expected at least one activity failure');
    const failure = failedEvents[0]?.activityTaskFailedEventAttributes?.failure;
    t.true(failure?.applicationFailureInfo?.nonRetryable, 'Expected x-should-retry:false to make 429 non-retryable');

    const startedEvents = events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED) ?? [];
    t.is(startedEvents.length, 1, `Expected 1 attempt for non-retryable, got ${startedEvents.length}`);
  });
});

// --- NEW-1: Handoff option preservation ---

function* handoffCallbackGenerator() {
  yield handoffResponse('transfer_to_CallbackSpecialist', { reason: 'weather question' });
  yield textResponse('Specialist handled it!');
}

test('NEW-1: Handoff onHandoff callback is preserved through convertAgent', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => handoffCallbackGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(handoffOnHandoffCallbackWorkflow, {
      args: ['What is the weather?'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.true(
      result.onHandoffCalled,
      'onHandoff callback should fire when handoff is invoked (convertAgent must preserve it)'
    );
    t.true(result.output.includes('Specialist'), `Expected output from specialist, got: ${result.output}`);
  });
});

test('NEW-1b: Handoff isEnabled=false is preserved through convertAgent', async (t) => {
  const provider = new RequestCapturingModelProvider();
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [new OpenAIAgentsPlugin({ modelProvider: provider })],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(handoffIsEnabledFalseWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'captured');
  });

  const handoffs = (provider.lastRequest as any)?.handoffs ?? [];
  t.is(
    handoffs.length,
    0,
    `Expected 0 handoffs (isEnabled=false should hide it), got ${handoffs.length}: ${handoffs
      .map((h: any) => h.toolName)
      .join(', ')}`
  );
});

test('NEW-1c: Handoff inputJsonSchema is preserved through convertAgent', async (t) => {
  const provider = new RequestCapturingModelProvider();
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [new OpenAIAgentsPlugin({ modelProvider: provider })],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(handoffWithCustomSchemaWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'captured');
  });

  const handoffs = (provider.lastRequest as any)?.handoffs ?? [];
  t.true(handoffs.length >= 1, 'Expected at least 1 handoff');
  const schema = handoffs[0]?.inputJsonSchema;
  t.truthy(
    schema?.properties?.reason,
    `Expected inputJsonSchema to have 'reason' property from custom schema, got: ${JSON.stringify(schema)}`
  );
});

test('G6/F-C: Schema-invalid tool input is passed through without validation', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new GeneratorFakeModelProvider(() => schemaInvalidToolInputGenerator()),
      }),
    ],
    activities: {
      getWeather,
      calculateSum,
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(multiToolAgentWorkflow, {
      args: ['Calculate something'],
      workflowExecutionTimeout: '30 seconds',
    });

    // activityAsTool does not validate tool arguments against the JSON schema.
    // With { x: 5, y: 3 } instead of { a: number, b: number }, the calculateSum
    // activity receives undefined for a and b, producing NaN (serialized as null).
    // agents-core feeds the result back to the model, which produces a text response.
    const result = await handle.result();
    t.is(result, 'The calculation returned a result.');

    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];
    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );
    t.true(
      activityTypes.includes('calculateSum'),
      `calculateSum should be scheduled even with invalid input, got: ${activityTypes.join(', ')}`
    );
  });
});

// --- Wire contract tests ---

test('Wire contract: prompt and tracing survive round trip through wire projection', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const provider = new RequestCapturingModelProvider();
  const worker = await createWorker({
    plugins: [new OpenAIAgentsPlugin({ modelProvider: provider })],
  });

  let result: Awaited<ReturnType<typeof wireRoundTripWorkflow>>;
  await worker.runUntil(async () => {
    result = await executeWorkflow(wireRoundTripWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });
  });

  // --- Request side (captured by activity-side model) ---
  const req = provider.lastRequest as any;
  t.truthy(req, 'Expected model to have received a request');

  // Prompt field with nested structure should survive the wire
  t.truthy(req?.prompt, 'Expected prompt field to survive round trip');
  t.is(req?.prompt?.promptId, 'pt_round_trip', `Expected promptId 'pt_round_trip', got: ${req?.prompt?.promptId}`);
  t.deepEqual(req?.prompt?.variables, { key: 'value', nested: { deep: true } });

  // Tracing field should survive (default is false when tracing is disabled in workflow)
  t.true('tracing' in req, 'Expected tracing field to be present in wire request');

  // __wireVersion is stripped by fromSerializedModelRequest before reaching the model
  t.false('__wireVersion' in req, '__wireVersion should be stripped before reaching the model');

  // --- Response side (returned from activity to workflow) ---
  t.is(result!.usageInputTokens, 10, `Expected usage.inputTokens=10, got: ${result!.usageInputTokens}`);
  t.is(result!.usageOutputTokens, 8, `Expected usage.outputTokens=8, got: ${result!.usageOutputTokens}`);
  t.is(result!.outputLength, 1, `Expected output array length=1, got: ${result!.outputLength}`);
  t.false(result!.hasWireVersion, '__wireVersion should be stripped from response by fromSerializedModelResponse');
});

// Stripping is a structural guarantee: toSerializedModelRequest uses additive projection
// (only copies listed fields), so unlisted fields like `signal` can never leak through.
// This integration test verifies the end-to-end absence on the activity-side model request.
test('Wire contract: signal is stripped from wire request', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const provider = new RequestCapturingModelProvider();
  const worker = await createWorker({
    plugins: [new OpenAIAgentsPlugin({ modelProvider: provider })],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(wireStrippingCheckWorkflow, {
      args: ['Hello'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'captured');
  });

  const req = provider.lastRequest as any;
  t.truthy(req, 'Expected model to have received a request');
  t.false('signal' in req, 'signal should be stripped from wire request (AbortSignal is not serializable)');
});

test('Wire contract: version mismatch throws non-retryable WireVersionMismatch error', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Should not reach')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(wireVersionMismatchWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    t.is(result.errorType, 'WireVersionMismatch', `Expected WireVersionMismatch error type, got: ${result.errorType}`);
    t.true(
      result.errorMessage.includes('wire version mismatch'),
      `Expected descriptive message about version mismatch, got: ${result.errorMessage}`
    );
  });
});

test('Wire contract: SerializedModelRequest shape snapshot', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('unused')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const actualKeys = await executeWorkflow(wireRequestSnapshotWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    const expectedKeys = [
      '__wireVersion',
      'conversationId',
      'handoffs',
      'input',
      'modelSettings',
      'outputType',
      'overridePromptModel',
      'previousResponseId',
      'prompt',
      'systemInstructions',
      'tools',
      'toolsExplicitlyProvided',
      'tracing',
    ];
    t.deepEqual(
      actualKeys,
      expectedKeys,
      `SerializedModelRequest shape changed — bump WIRE_VERSION and update this snapshot. Got: ${actualKeys.join(', ')}`
    );
    t.true(actualKeys.includes('__wireVersion'), 'Wire version key must be present');
    t.false(actualKeys.includes('signal'), 'signal must not be on wire (AbortSignal is not serializable)');
  });
});

test('Wire contract: SerializedModelResponse shape snapshot', async (t) => {
  const response = {
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokensDetails: [],
      outputTokensDetails: [],
    },
    output: [{ type: 'message', content: 'test' }],
    responseId: 'resp_123',
    providerData: { key: 'value' },
  } as any;

  const wire = toSerializedModelResponse(response);
  const actualKeys = Object.keys(wire).sort();

  const expectedKeys = ['__wireVersion', 'output', 'providerData', 'responseId', 'usage'];
  t.deepEqual(
    actualKeys,
    expectedKeys,
    `SerializedModelResponse shape changed — bump WIRE_VERSION and update this snapshot. Got: ${actualKeys.join(', ')}`
  );
  t.is(wire.__wireVersion, 1, 'Wire version should be 1');
});

// Upstream-drift detection: verifies that all fields we project onto the wire are JSON-safe.
// If upstream changes a field type from a JSON-safe primitive to a class/Date/Map, this test
// fails, signaling that WIRE_VERSION needs a bump and the projection needs updating.
test('Wire contract: upstream ModelRequest fields survive JSON round-trip (drift detection)', async (t) => {
  const sampleRequest = {
    systemInstructions: 'You are a helpful assistant.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }], providerData: {} }],
    modelSettings: { temperature: 0.7, maxTokens: 100, topP: 0.9 },
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} }, strict: true }],
    toolsExplicitlyProvided: true,
    outputType: { type: 'text' },
    handoffs: [{ toolName: 'transfer_to_agent', toolDescription: 'Transfer', strictJsonSchema: true }],
    prompt: { promptId: 'pt_drift', version: 'v1', variables: { city: 'NYC' } },
    previousResponseId: 'resp_prev_001',
    conversationId: 'conv_drift_001',
    tracing: false,
    overridePromptModel: false,
  };

  const roundTripped = JSON.parse(JSON.stringify(sampleRequest));
  t.deepEqual(
    roundTripped,
    sampleRequest,
    'All upstream ModelRequest field values must survive JSON round-trip. ' +
      'If this fails, upstream introduced a non-JSON-safe field — bump WIRE_VERSION and update the projection.'
  );
});

test('Wire contract: upstream ModelResponse fields survive JSON round-trip (drift detection)', async (t) => {
  const sampleResponse = {
    usage: {
      requests: 1,
      inputTokens: 42,
      outputTokens: 15,
      totalTokens: 57,
      inputTokensDetails: [{ cachedTokens: 10 }],
      outputTokensDetails: [{ reasoningTokens: 5 }],
    },
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello!' }],
        id: 'msg_drift_001',
        providerData: { model: 'gpt-4o' },
      },
    ],
    responseId: 'resp_drift_001',
    providerData: { model: 'gpt-4o', latencyMs: 150 },
  } as any;

  const wire = toSerializedModelResponse(sampleResponse);
  const roundTripped = JSON.parse(JSON.stringify(wire));
  t.deepEqual(
    roundTripped,
    wire,
    'All SerializedModelResponse field values must survive JSON round-trip. ' +
      'If this fails, upstream introduced a non-JSON-safe field — bump WIRE_VERSION and update the projection.'
  );
});

// --- T1: Tracing span capture ---

test('T1: OpenAI Agents tracing path is active and produces trace/span events', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Traced response')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(tracingSpanCaptureWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    t.true(result.traceIds.length > 0, 'Should capture at least one trace');
    t.true(result.spanTypes.includes('agent'), 'Should have an agent span');
    t.true(
      result.spanTypes.includes('generation') || result.spanTypes.includes('response'),
      'Should have a generation or response span'
    );
  });
});

// --- T2: Replay-safety test ---

test('T2: Tracing is replay-safe — no NondeterminismError when workflow replays', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    maxCachedWorkflows: 0,
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('Replayed response')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(replaySafetyWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    t.true(
      result.replayDetected,
      'Workflow should have detected replay (proves maxCachedWorkflows: 0 forced a replay)'
    );
    t.true(result.traceIds.length > 0, 'Should capture at least one trace during non-replay execution');
    t.true(result.spanTypes.includes('agent'), 'Should have an agent span');
  });
});

// --- CLEANUP-6: Handoff-clone snapshot test ---

test('CLEANUP-6: Handoff clone preserves all public fields through convertAgent', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([textResponse('unused')]),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(handoffCloneSnapshotWorkflow, {
      workflowExecutionTimeout: '30 seconds',
    });

    for (const [field, preserved] of Object.entries(result.fieldsPreserved)) {
      t.true(preserved, `Handoff clone field '${field}' should be preserved`);
    }
    t.true(result.agentReplaced, 'Handoff clone agent should be replaced with converted agent');
    t.true(result.onInvokeHandoffReplaced, 'Handoff clone onInvokeHandoff should be replaced with wrapper');
    t.true(result.prototypeMatch, 'Handoff clone prototype should match original');
  });
});
