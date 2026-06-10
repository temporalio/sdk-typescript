import test from 'ava';
import { RequestUsage, Usage, type ModelResponse } from '@openai/agents-core';
import { toSerializedModelResponse } from '../worker/activities';
import { toSerializedModelRequest } from '../workflow/activity-backed-model';

test('toSerializedModelRequest: signal field is structurally absent on wire (selective whitelist projection)', (t) => {
  const request: any = {
    systemInstructions: 'sys',
    input: 'hi',
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: false,
    outputType: undefined,
    handoffs: [],
    prompt: undefined,
    previousResponseId: undefined,
    conversationId: undefined,
    tracing: false,
    overridePromptModel: false,
    signal: new AbortController().signal,
  };
  const wire = toSerializedModelRequest(request);
  t.false('signal' in wire, 'signal must not be on wire (AbortSignal is not serializable)');
});

test('toSerializedModelRequest: shape snapshot pins the exact key set', (t) => {
  const request: any = {
    systemInstructions: 'sys',
    input: 'hi',
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: false,
    outputType: undefined,
    handoffs: [],
    prompt: undefined,
    previousResponseId: undefined,
    conversationId: undefined,
    tracing: false,
    overridePromptModel: false,
  };
  const actualKeys = Object.keys(toSerializedModelRequest(request)).sort();
  const expectedKeys = [
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
  t.deepEqual(actualKeys, expectedKeys);
});

test('toSerializedModelRequest: built-in / hosted tools survive the projection', (t) => {
  const request: any = {
    systemInstructions: undefined,
    input: 'hi',
    modelSettings: {},
    tools: [{ type: 'web_search', name: 'web_search' } as any],
    toolsExplicitlyProvided: false,
    outputType: undefined,
    handoffs: [],
    prompt: undefined,
    previousResponseId: undefined,
    conversationId: undefined,
    tracing: false,
    overridePromptModel: false,
  };
  const wire = toSerializedModelRequest(request);
  t.deepEqual(wire.tools, [{ type: 'web_search', name: 'web_search' }]);
  t.deepEqual(JSON.parse(JSON.stringify(wire)).tools, [{ type: 'web_search', name: 'web_search' }]);
});

test('toSerializedModelResponse: shape snapshot pins the exact key set', (t) => {
  const response: any = {
    usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    output: [{ type: 'message', content: 'test' }],
    responseId: 'resp_123',
    providerData: { key: 'value' },
  };
  const wire = toSerializedModelResponse(response);
  const actualKeys = Object.keys(wire).sort();
  t.deepEqual(actualKeys, ['output', 'providerData', 'responseId', 'usage']);
});

test('drift detection: ModelRequest sample is JSON-safe (round-trip preserves all field values)', (t) => {
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
  t.deepEqual(JSON.parse(JSON.stringify(sampleRequest)), sampleRequest);
});

test('toSerializedModelResponse: strips class methods, maps requestUsageEntries, JSON-safe round-trip', (t) => {
  // Real Usage / RequestUsage instances — projection must strip their methods.
  const usage = new Usage({
    requests: 1,
    inputTokens: 42,
    outputTokens: 15,
    totalTokens: 57,
    inputTokensDetails: [{ cachedTokens: 10 }],
    outputTokensDetails: [{ reasoningTokens: 5 }],
  });
  usage.requestUsageEntries = [
    new RequestUsage({
      inputTokens: 42,
      outputTokens: 15,
      totalTokens: 57,
      inputTokensDetails: { cachedTokens: 10 },
      outputTokensDetails: { reasoningTokens: 5 },
      endpoint: '/v1/responses',
    }),
  ];
  const response: ModelResponse = {
    usage,
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
  };

  const wire = toSerializedModelResponse(response);

  t.false(wire.usage instanceof Usage, 'wire.usage must be a plain object, not a Usage instance');
  const wireUsage = wire.usage as any;
  t.is(wireUsage.inputTokens, 42);
  t.is(wireUsage.outputTokens, 15);
  t.is(wireUsage.totalTokens, 57);
  t.deepEqual(wireUsage.requestUsageEntries, [
    {
      inputTokens: 42,
      outputTokens: 15,
      totalTokens: 57,
      inputTokensDetails: { cachedTokens: 10 },
      outputTokensDetails: { reasoningTokens: 5 },
      endpoint: '/v1/responses',
    },
  ]);
  t.false(wireUsage.requestUsageEntries[0] instanceof RequestUsage, 'entries must be plain objects, not RequestUsage');
  t.deepEqual(JSON.parse(JSON.stringify(wire)), wire);
});
