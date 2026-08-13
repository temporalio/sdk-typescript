import test from 'ava';
import { Usage, type ModelProvider, type ModelResponse, type StreamEvent } from '@openai/agents-core';
import type { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { MockActivityEnvironment } from '@temporalio/testing';
import type {
  InvokeModelActivityInput,
  InvokeModelStreamActivityInput,
  SerializedModelRequest,
  SerializedModelResponse,
  SerializedStreamEvent,
} from '../common/serialized-model';
import { createModelActivity } from '../worker/activities';

const MCP_AUTH = 'sk-echo-mcp-authorization-sentinel';
const MCP_HEADER = 'sk-echo-mcp-header-sentinel';
const SHELL_SECRET = 'sk-echo-shell-domain-sentinel';
const CODE_SECRET = 'sk-echo-code-interpreter-domain-sentinel';
const SENTINELS = [MCP_AUTH, MCP_HEADER, SHELL_SECRET, CODE_SECRET];

/** The four credential positions as OpenAI echoes them back inside `Response.tools`. */
function echoedTools(): unknown[] {
  return [
    {
      type: 'mcp',
      server_label: 'docs',
      server_url: 'https://mcp.example.com',
      authorization: MCP_AUTH,
      headers: { 'X-Api-Key': MCP_HEADER },
    },
    {
      type: 'shell',
      container: {
        type: 'auto',
        network_policy: {
          type: 'allowlist',
          domain_secrets: [{ domain: 'b.example.com', name: 'REF_TOKEN', value: SHELL_SECRET }],
        },
      },
    },
    {
      type: 'code_interpreter',
      container: {
        type: 'auto',
        network_policy: {
          type: 'allowlist',
          domain_secrets: [{ domain: 'b.example.com', name: 'REF_TOKEN', value: CODE_SECRET }],
        },
      },
    },
  ];
}

/** The MCP server's advertised list — the value of a key named `tools`, in both output shapes that carry one. */
const ADVERTISED_TOOLS = [{ name: 'search_docs', input_schema: { type: 'object' } }];

/** An `mcp_list_tools` item as it appears inside the raw `Response.output`. */
const RAW_MCP_LIST_TOOLS_ITEM = {
  type: 'mcp_list_tools',
  id: 'mcpl_1',
  server_label: 'docs',
  tools: ADVERTISED_TOOLS,
};

/** The agents-SDK counterpart, as it appears in `ModelResponse.output`. */
const MCP_LIST_TOOLS_ITEM = {
  type: 'hosted_tool_call',
  name: 'mcp_list_tools',
  id: 'mcpl_1',
  providerData: { type: 'mcp_list_tools', server_label: 'docs', tools: ADVERTISED_TOOLS },
};

/** Everything on the raw `Response` other than `tools` — all of it must survive. */
function responseRest(): Record<string, unknown> {
  return {
    id: 'resp_echo_001',
    object: 'response',
    model: 'gpt-5',
    status: 'completed',
    parallel_tool_calls: true,
    metadata: { tenant: 'acme' },
    output: [RAW_MCP_LIST_TOOLS_ITEM],
  };
}

function rawResponse(): Record<string, unknown> {
  return { ...responseRest(), tools: echoedTools() };
}

function minimalRequest(): SerializedModelRequest {
  return {
    input: 'hi',
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: false,
    outputType: 'text',
    handoffs: [],
    tracing: false,
    overridePromptModel: false,
  };
}

function payloadText(input: unknown): string {
  return Buffer.from(defaultPayloadConverter.toPayload(input)!.data!).toString('utf8');
}

function countSentinels(input: unknown): number {
  const text = payloadText(input);
  return SENTINELS.filter((sentinel) => text.includes(sentinel)).length;
}

/** Decodes one published stream item back through the real payload converter. */
function decodePublished(item: { data: string }): { bytes: Buffer; event: unknown } {
  const bytes = Buffer.from(item.data, 'base64');
  const payload = temporal.api.common.v1.Payload.decode(bytes);
  return { bytes, event: defaultPayloadConverter.fromPayload(payload) };
}

function respondingProvider(response: ModelResponse): ModelProvider {
  return {
    getModel: () => ({
      async getResponse() {
        return response;
      },
      getStreamedResponse(): AsyncIterable<StreamEvent> {
        throw new Error('unused');
      },
    }),
  };
}

function streamingProvider(events: StreamEvent[]): ModelProvider {
  return {
    getModel: () => ({
      async getResponse(): Promise<ModelResponse> {
        throw new Error('unused');
      },
      async *getStreamedResponse() {
        for (const event of events) yield event;
      },
    }),
  };
}

function recordingClient(published: Array<{ data: string }>): Client {
  return {
    withAbortSignal: <R>(_signal: AbortSignal, fn: () => Promise<R>) => fn(),
    workflow: {
      getHandle: (workflowId: string) => ({
        workflowId,
        async signal(_name: string, input: { items: Array<{ data: string }> }) {
          published.push(...input.items);
        },
      }),
    },
  } as unknown as Client;
}

/** The four raw-response positions a single streamed turn carries. */
function echoingStreamEvents(): StreamEvent[] {
  // `response_done` carries the raw response minus `output`/`usage`/`id`.
  const { id, output: _output, ...remainingResponse } = responseRest();
  return [
    {
      type: 'response_started',
      providerData: { type: 'response.created', sequence_number: 0, response: rawResponse() },
    },
    {
      type: 'model',
      event: { type: 'response.created', sequence_number: 0, response: rawResponse() },
      providerData: { rawModelEventSource: 'openai.responses' },
    },
    { type: 'output_text_delta', delta: 'hi', providerData: { item_id: 'i1', output_index: 0 } },
    {
      type: 'model',
      event: { type: 'response.output_text.delta', item_id: 'i1', delta: 'hi' },
      providerData: { rawModelEventSource: 'openai.responses' },
    },
    {
      type: 'model',
      event: { type: 'response.completed', sequence_number: 9, response: rawResponse() },
      providerData: { rawModelEventSource: 'openai.responses' },
    },
    {
      type: 'response_done',
      response: {
        id: id as string,
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [MCP_LIST_TOOLS_ITEM],
        providerData: { ...remainingResponse, tools: echoedTools() },
      },
      providerData: { type: 'response.completed', sequence_number: 9 },
    },
  ] as unknown as StreamEvent[];
}

test('invokeModelActivity drops the echoed tools from the raw response, keeping everything else', async (t) => {
  const response: ModelResponse = {
    usage: new Usage(),
    output: [MCP_LIST_TOOLS_ITEM] as unknown as ModelResponse['output'],
    responseId: 'resp_echo_001',
    providerData: rawResponse(),
  };

  // Positive control: unstripped, every sentinel reaches the payload.
  t.is(countSentinels(response.providerData), SENTINELS.length);

  const { invokeModelActivity } = createModelActivity(respondingProvider(response));
  const input: InvokeModelActivityInput = { modelName: 'gpt-5', request: minimalRequest() };
  const result: SerializedModelResponse = await new MockActivityEnvironment().run(invokeModelActivity, input);

  t.is(countSentinels(result), 0, 'no sentinel survives into the Activity result');
  t.deepEqual(result.providerData, responseRest(), 'providerData is the raw response minus tools, not reshaped');
  t.deepEqual(
    (result.output[0] as typeof MCP_LIST_TOOLS_ITEM).providerData.tools,
    ADVERTISED_TOOLS,
    'the agents-SDK mcp_list_tools item keeps its advertised tool list'
  );
  t.deepEqual(
    (result.providerData!.output as (typeof RAW_MCP_LIST_TOOLS_ITEM)[])[0]!.tools,
    ADVERTISED_TOOLS,
    'so does the raw mcp_list_tools item nested inside providerData.output'
  );
});

test('invokeModelActivity leaves a provider response without echoed tools untouched, by identity', async (t) => {
  const providerData = { model: 'gpt-5', latencyMs: 150 };
  const response: ModelResponse = { usage: new Usage(), output: [], responseId: 'r', providerData };

  const { invokeModelActivity } = createModelActivity(respondingProvider(response));
  const result: SerializedModelResponse = await new MockActivityEnvironment().run(invokeModelActivity, {
    modelName: 'gpt-5',
    request: minimalRequest(),
  });

  t.is(result.providerData, providerData);
});

test('invokeModelStreamActivity drops echoed tools from every returned and published event', async (t) => {
  const events = echoingStreamEvents();

  // Positive control, per event: four of the six carry a raw response.
  const carriers = events.filter((event) => countSentinels(event) === SENTINELS.length);
  t.is(carriers.length, 4, 'the fixture reproduces the ~4-per-turn multiplicity');
  t.deepEqual(
    carriers.map((event) => event.type),
    ['response_started', 'model', 'model', 'response_done'],
    'covering response_started, both raw model events, and response_done'
  );

  const published: Array<{ data: string }> = [];
  const { invokeModelStreamActivity } = createModelActivity(streamingProvider(events));
  const input: InvokeModelStreamActivityInput = {
    modelName: 'gpt-5',
    request: minimalRequest(),
    streamingTopic: 'events',
    streamingBatchInterval: '10ms',
  };

  const returned: SerializedStreamEvent[] = await new MockActivityEnvironment(undefined, {
    client: recordingClient(published),
  }).run(invokeModelStreamActivity, input);

  t.is(returned.length, events.length);
  t.is(countSentinels(returned), 0, 'no sentinel survives into the Activity result');

  t.is(published.length, events.length, 'every event is published');
  for (const [index, item] of published.entries()) {
    const { bytes, event } = decodePublished(item);
    for (const sentinel of SENTINELS) {
      t.false(bytes.includes(sentinel), `published event ${index}: ${sentinel} must not reach the stream`);
    }
    t.deepEqual(event, returned[index], `published event ${index} matches the returned one`);
  }
});

test('stripping a stream event removes only tools, leaving every other field in place', async (t) => {
  const events = echoingStreamEvents();
  const { id, output: _output, ...remainingResponse } = responseRest();

  const { invokeModelStreamActivity } = createModelActivity(streamingProvider(events));
  const returned: SerializedStreamEvent[] = await new MockActivityEnvironment(undefined, {
    client: recordingClient([]),
  }).run(invokeModelStreamActivity, {
    modelName: 'gpt-5',
    request: minimalRequest(),
    streamingTopic: 'events',
    streamingBatchInterval: '10ms',
  });

  t.deepEqual(returned, [
    {
      type: 'response_started',
      providerData: { type: 'response.created', sequence_number: 0, response: responseRest() },
    },
    {
      type: 'model',
      event: { type: 'response.created', sequence_number: 0, response: responseRest() },
      providerData: { rawModelEventSource: 'openai.responses' },
    },
    { type: 'output_text_delta', delta: 'hi', providerData: { item_id: 'i1', output_index: 0 } },
    {
      type: 'model',
      event: { type: 'response.output_text.delta', item_id: 'i1', delta: 'hi' },
      providerData: { rawModelEventSource: 'openai.responses' },
    },
    {
      type: 'model',
      event: { type: 'response.completed', sequence_number: 9, response: responseRest() },
      providerData: { rawModelEventSource: 'openai.responses' },
    },
    {
      type: 'response_done',
      response: {
        id,
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [MCP_LIST_TOOLS_ITEM],
        providerData: remainingResponse,
      },
      providerData: { type: 'response.completed', sequence_number: 9 },
    },
  ] as unknown as SerializedStreamEvent[]);
});
