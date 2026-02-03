/**
 * Test AI SDK integration with Temporal workflows
 */
import type {
  EmbeddingModelV3,
  EmbeddingModelV3CallOptions,
  EmbeddingModelV3Result,
  ImageModelV3,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  ProviderV3,
  TranscriptionModelV3,
} from '@ai-sdk/provider';
import { openai } from '@ai-sdk/openai';
import { v4 as uuid4 } from 'uuid';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ExportResultCode } from '@opentelemetry/core';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { AiSdkPlugin, createActivities } from '@temporalio/ai-sdk';
import { temporal } from '@temporalio/proto';
import { WorkflowClient } from '@temporalio/client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
  OpenTelemetrySinks,
  OpenTelemetryWorkflowClientCallsInterceptor,
  OpenTelemetryWorkflowClientInterceptor,
} from '@temporalio/interceptors-opentelemetry';
import { InjectedSinks, Runtime } from '@temporalio/worker';
import {
  embeddingWorkflow,
  generateObjectWorkflow,
  helloWorldAgent,
  mcpSchemaTestWorkflow,
  mcpWorkflow,
  middlewareWorkflow,
  telemetryWorkflow,
  toolsWorkflow,
} from './workflows/ai-sdk';
import { helpers, makeTestFunction } from './helpers-integration';
import { getWeather } from './activities/ai-sdk';
import { Worker } from './helpers';
import EventType = temporal.api.enums.v1.EventType;

const remoteTests = ['1', 't', 'true'].includes((process.env.AI_SDK_REMOTE_TESTS ?? 'false').toLowerCase());

export type ModelResponse = LanguageModelV3GenerateResult;

export class TestModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'temporal';
  readonly modelId = 'TestModel';
  private generator: Generator<ModelResponse>;
  private done: boolean = false;

  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }

  get supportedUrls(): Record<string, RegExp[]> {
    return {};
  }

  async doGenerate(_: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    if (this.done) {
      throw new Error('Called generate more times than responses given to the test generator');
    }

    const result = this.generator.next();
    this.done = result.done ?? false;
    return result.value;
  }

  doStream(_options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
    throw new Error('Streaming not supported.');
  }
}

export type EmbeddingResponse = EmbeddingModelV3Result;

export class TestEmbeddingModel implements EmbeddingModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'temporal';
  readonly modelId = 'TestEmbeddingModel';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  private generator: Generator<EmbeddingResponse>;
  private done: boolean = false;

  constructor(generator: Generator<EmbeddingResponse>) {
    this.generator = generator;
  }

  async doEmbed(_options: EmbeddingModelV3CallOptions): Promise<EmbeddingModelV3Result> {
    if (this.done) {
      throw new Error('Called embed more times than responses given to the test generator');
    }

    const result = this.generator.next();
    this.done = result.done ?? false;
    return result.value;
  }
}

export class TestProvider implements ProviderV3 {
  readonly specificationVersion = 'v3';
  private languageModelGenerator: Generator<ModelResponse>;
  private embeddingModelGenerator?: Generator<EmbeddingResponse>;

  constructor(
    languageModelGenerator: Generator<ModelResponse>,
    embeddingModelGenerator?: Generator<EmbeddingResponse>
  ) {
    this.languageModelGenerator = languageModelGenerator;
    this.embeddingModelGenerator = embeddingModelGenerator;
  }

  imageModel(_modelId: string): ImageModelV3 {
    throw new Error('Not implemented');
  }

  languageModel(_modelId: string): LanguageModelV3 {
    return new TestModel(this.languageModelGenerator);
  }

  embeddingModel(_modelId: string): EmbeddingModelV3 {
    if (!this.embeddingModelGenerator) {
      throw new Error('Embedding model generator not provided');
    }
    return new TestEmbeddingModel(this.embeddingModelGenerator);
  }

  transcriptionModel(_modelId: string): TranscriptionModelV3 {
    throw new Error('Not implemented');
  }
}

function createFinishReason(
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'
): LanguageModelV3FinishReason {
  return { unified, raw: undefined };
}

function createUsage(inputTokens: number = 10, outputTokens: number = 20): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function contentResponse(
  content: LanguageModelV3Content[],
  finishReason: LanguageModelV3FinishReason = createFinishReason('stop')
): ModelResponse {
  return {
    content,
    finishReason,
    usage: createUsage(),
    warnings: [],
  };
}

function textResponse(content: string): ModelResponse {
  return contentResponse([
    {
      type: 'text',
      text: content,
    },
  ]);
}

function toolCallResponse(toolName: string, input: string): ModelResponse {
  return contentResponse(
    [
      {
        type: 'tool-call',
        toolCallId: 'call_yY3nlDwH5BQSJo63qC61L4ZB',
        toolName,
        input,
      },
    ],
    createFinishReason('tool-calls')
  );
}

function embeddingResponse(values: string[]): EmbeddingResponse {
  // Generate mock embeddings (1536-dimensional vectors like OpenAI's text-embedding-3-small)
  const embeddings = values.map((_, index) => {
    const embedding = new Array(1536).fill(0).map((_, i) => Math.sin(index + i * 0.01));
    return embedding;
  });
  return {
    embeddings,
    usage: {
      tokens: values.reduce((acc, v) => acc + v.length, 0),
    },
    warnings: [],
  };
}

function* helloWorkflowGenerator(): Generator<ModelResponse> {
  yield textResponse('Test Haiku');
}

function* embeddingGenerator(): Generator<EmbeddingResponse> {
  yield embeddingResponse(['Hello, world!', 'How are you?']);
}

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/ai-sdk'),
});

test('Hello world agent responds in haikus', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(helloWorkflowGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(helloWorldAgent, {
      args: ['Tell me about recursion in programming.'],
    });

    t.assert(result);
    if (!remoteTests) {
      t.is('Test Haiku', result);
    }
  });
});

function* toolsWorkflowGenerator(): Generator<ModelResponse> {
  yield toolCallResponse('getWeather', '{"location":"Tokyo"}');
  yield textResponse('Test weather result');
}

test('Tools workflow can use AI tools', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(toolsWorkflowGenerator()),
      }),
    ],
    activities: {
      getWeather,
    },
  });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(toolsWorkflow, {
      args: ['What is the weather in Tokyo?'],
      workflowExecutionTimeout: '10 seconds',
    });

    const result = await handle.result();

    t.assert(result);
    if (!remoteTests) {
      t.is('Test weather result', result);

      // Check that activities were scheduled
      const { events } = await handle.fetchHistory();
      const activityCompletedEvents =
        events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

      // Should have at least 2 events: invokeModel and getWeather
      t.assert(
        activityCompletedEvents.length >= 2,
        `Expected at least 2 activity completions, got ${activityCompletedEvents.length}`
      );

      // Check that getWeather activity was called
      const activityTypes = activityCompletedEvents.map(
        (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
      );
      t.assert(activityTypes.includes('getWeather'), 'getWeather activity should have been called');
    }
  });
});

function* generateObjectWorkflowGenerator(): Generator<ModelResponse> {
  yield textResponse(
    '{"recipe":{"name":"Classic Lasagna","ingredients":[],"steps":["Preheat the oven to 375°F (190°C)."]}}'
  );
}

test('Generate object', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(generateObjectWorkflowGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(generateObjectWorkflow, {
      args: ['Tell me about recursion in programming.'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.assert(result);
    if (!remoteTests) {
      t.is('Classic Lasagna', result);
    }
  });
});

test('Middleware', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(helloWorkflowGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(middlewareWorkflow, {
      args: ['Tell me about recursion in programming.'],
      workflowExecutionTimeout: '30 seconds',
    });

    t.assert(result);
    if (!remoteTests) {
      t.is('Test Haiku', result);
    }
  });
});

test('Embedding model generates embeddings', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(helloWorkflowGenerator(), embeddingGenerator()),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(embeddingWorkflow, {
      args: [['Hello, world!', 'How are you?']],
      workflowExecutionTimeout: '30 seconds',
    });

    const result = await handle.result();

    t.assert(result);
    t.is(result.count, 2);
    t.is(result.dimensions, 1536);

    // Check that the embedding activity was scheduled
    const { events } = await handle.fetchHistory();
    const activityScheduledEvents =
      events?.filter((e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) ?? [];

    // Should have at least 1 event: invokeEmbeddingModel
    t.assert(
      activityScheduledEvents.length >= 1,
      `Expected at least 1 activity scheduled, got ${activityScheduledEvents.length}`
    );

    // Check that invokeEmbeddingModel activity was called
    const activityTypes = activityScheduledEvents.map(
      (e) => e?.activityTaskScheduledEventAttributes?.activityType?.name
    );
    t.assert(activityTypes.includes('invokeEmbeddingModel'), 'invokeEmbeddingModel activity should have been called');
  });
});

test('Telemetry', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  try {
    const spans = Array<opentelemetry.tracing.ReadableSpan>();

    const staticResource = new opentelemetry.resources.Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'ts-test-otel-worker',
    });
    const traceExporter: opentelemetry.tracing.SpanExporter = {
      export(spans_, resultCallback) {
        spans.push(...spans_);
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      async shutdown() {
        // Nothing to shutdown
      },
    };
    const otel = new opentelemetry.NodeSDK({
      resource: staticResource,
      traceExporter,
    });
    await otel.start();
    const sinks: InjectedSinks<OpenTelemetrySinks> = {
      exporter: makeWorkflowExporter(traceExporter, staticResource),
    };

    const worker = await Worker.create({
      plugins: [
        new AiSdkPlugin({
          modelProvider: remoteTests ? openai : new TestProvider(helloWorkflowGenerator()),
        }),
      ],
      taskQueue: 'test-ai-telemetry',
      workflowsPath: require.resolve('./workflows/ai-sdk'),

      interceptors: {
        client: {
          workflow: [new OpenTelemetryWorkflowClientCallsInterceptor()],
        },
        workflowModules: [require.resolve('./workflows/otel-interceptors')],
        activity: [
          (ctx) => ({
            inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
            outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
          }),
        ],
      },
      sinks,
    });

    const client = new WorkflowClient({
      interceptors: [new OpenTelemetryWorkflowClientInterceptor()],
    });
    await worker.runUntil(async () => {
      await client.execute(telemetryWorkflow, {
        taskQueue: 'test-ai-telemetry',
        workflowId: uuid4(),
        args: ['Tell me about recursion'],
      });
    });
    await otel.shutdown();
    const generateSpan = spans.find(({ name }) => name === `ai.generateText`);
    t.true(generateSpan !== undefined);
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

function* mcpGenerator(): Generator<ModelResponse> {
  yield toolCallResponse('list_directory', '/');
  yield textResponse('Some files');
}

test('callToolActivity awaits tool.execute before closing MCP client', async (t) => {
  // Track the order of operations to verify close() is called AFTER execute() completes
  const operationOrder: string[] = [];

  // Create a mock MCP client that tracks when close() is called
  // We only need to implement the methods used by callToolActivity: tools() and close()
  const mockMcpClient = {
    async tools() {
      return {
        testTool: {
          description: 'A test tool',
          inputSchema: { type: 'object' },
          execute: async (_input: unknown, _options: unknown) => {
            operationOrder.push('execute-start');
            // Simulate async work - without await in the activity, close() will be called before this resolves
            await new Promise((resolve) => setTimeout(resolve, 50));
            operationOrder.push('execute-end');
            return { result: 'success' };
          },
        },
      };
    },
    async close() {
      operationOrder.push('close');
    },
  };

  // Create a factory that returns the mock client - cast to any since we only implement the methods we need
  const mockMcpClientFactory = async () => mockMcpClient as any;

  // Create activities with the mock MCP client factory
  const activities = createActivities(new TestProvider(helloWorkflowGenerator()), {
    testServer: mockMcpClientFactory,
  }) as Record<string, (args: unknown) => Promise<unknown>>;

  // Get the callTool activity
  const callToolActivity = activities['testServer-callTool'];
  t.truthy(callToolActivity, 'callToolActivity should exist');

  // Call the activity
  const result = await callToolActivity({
    name: 'testTool',
    input: {},
    options: {},
  });

  // Verify the result
  t.deepEqual(result, { result: 'success' });

  // Verify the order: execute should complete BEFORE close is called
  t.deepEqual(
    operationOrder,
    ['execute-start', 'execute-end', 'close'],
    'close() should be called after execute() completes, not before'
  );
});

test('MCP tool schema survives activity serialization', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  // Create in-memory MCP server with test tool
  const createTestMcpClient = async () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });

    // Register tools/list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'testTool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {
              testParam: { type: 'string', description: 'Test parameter' },
            },
            required: ['testParam'],
          },
        },
      ],
    }));

    // Register tools/call handler
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    // Create linked in-memory transports
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    // Return real AI SDK MCP client connected to in-memory server
    return createMCPClient({ transport: clientTransport });
  };

  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: new TestProvider(helloWorkflowGenerator()),
        mcpClientFactories: { testServer: createTestMcpClient },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(mcpSchemaTestWorkflow);

    // These would FAIL with the bug (undefined), PASS with fix
    t.is(result.schemaType, 'object', 'Schema type should be "object", not undefined');
    t.true(result.hasProperties, 'Schema should have properties');
    t.is(result.propertyDescription, 'Test parameter', 'Property description should be preserved');
  });
});

// Currently fails in CI due to invalid server response but passes locally
test.skip('MCP Use', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, executeWorkflow } = helpers(t);

  const mcpClientFactories = {
    testServer: () =>
      createMCPClient({
        transport: new StdioClientTransport({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem@latest', __dirname],
        }),
      }),
  };
  const worker = await createWorker({
    plugins: [
      new AiSdkPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(mcpGenerator()),
        mcpClientFactories,
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(mcpWorkflow, {
      args: ['Tell me what files you know about. Use your tools.'],
    });

    t.assert(result);
    if (!remoteTests) {
      t.is('Some files', result);
    }
  });
});
