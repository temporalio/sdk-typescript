/**
 * Test AI SDK integration with Temporal workflows
 */
import type {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ResponseMetadata,
  LanguageModelV2Usage,
  ProviderV2,
  SharedV2Headers,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider';
import { openai } from '@ai-sdk/openai';
import { v4 as uuid4 } from 'uuid';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ExportResultCode } from '@opentelemetry/core';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { AiSdkPlugin, McpClientFactory } from '@temporalio/ai-sdk';
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
  generateObjectWorkflow,
  helloWorldAgent,
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

export type ModelResponse = {
  content: Array<LanguageModelV2Content>;
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  providerMetadata?: SharedV2ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
  warnings: Array<LanguageModelV2CallWarning>;
};

export class TestModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'temporal';
  readonly supportedUrls = {};
  readonly modelId = 'TestModel';
  private generator: Generator<ModelResponse>;
  private done: boolean = false;

  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }

  async doGenerate(_: LanguageModelV2CallOptions): Promise<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    if (this.done) {
      throw new Error('Called generate more times than responses given to the test generator');
    }

    const result = this.generator.next();
    this.done = result.done ?? false;
    return result.value;
  }

  doStream(_options: LanguageModelV2CallOptions): PromiseLike<{
    stream: any;
    request?: { body?: unknown };
    response?: { headers?: SharedV2Headers };
  }> {
    throw new Error('Streaming not supported.');
  }
}

export class TestProvider implements ProviderV2 {
  private generator: Generator<ModelResponse>;
  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }
  imageModel(_modelId: string): ImageModelV2 {
    throw new Error('Not implemented');
  }

  languageModel(_modelId: string): LanguageModelV2 {
    return new TestModel(this.generator);
  }

  textEmbeddingModel(_modelId: string): EmbeddingModelV2<string> {
    throw new Error('Not implemented');
  }
}

function contentResponse(
  content: LanguageModelV2Content[],
  finishReason: LanguageModelV2FinishReason = 'stop'
): ModelResponse {
  return {
    content,
    finishReason,
    usage: {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    },
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
    'tool-calls'
  );
}

function* helloWorkflowGenerator(): Generator<ModelResponse> {
  yield textResponse('Test Haiku');
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

// Currently fails in CI due to invalid server response but passes locally
test.skip('MCP Use', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }
  const { createWorker, executeWorkflow } = helpers(t);

  const mcpClientFactories: [string, McpClientFactory][] = [
    [
      'testServer',
      () =>
        createMCPClient({
          transport: new StdioClientTransport({
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem@latest', __dirname],
          }),
        }),
    ],
  ];
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
