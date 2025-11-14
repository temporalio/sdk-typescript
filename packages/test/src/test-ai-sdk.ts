/**
 * Test AI SDK integration with Temporal workflows
 */
import { LanguageModelV2Content, LanguageModelV2FinishReason } from '@ai-sdk/provider';
import { openai } from '@ai-sdk/openai';
import { v4 as uuid4 } from 'uuid';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ExportResultCode } from '@opentelemetry/core';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { AiSDKPlugin, ModelResponse, TestProvider } from '@temporalio/ai-sdk';
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

const remoteTests = !!process.env.AI_SDK_REMOTE_TESTS;

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
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSDKPlugin({
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
  t.timeout(120 * 1000);
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSDKPlugin({
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
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSDKPlugin({
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
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new AiSDKPlugin({
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
  t.timeout(120 * 1000);
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
        new AiSDKPlugin({
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

test('MCP Use', async (t) => {
  t.timeout(120 * 1000);
  const { createWorker, executeWorkflow } = helpers(t);

  const mcpClientFactory = () =>
    createMCPClient({
      transport: new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', __dirname],
      }),
    });
  const worker = await createWorker({
    plugins: [
      new AiSDKPlugin({
        modelProvider: remoteTests ? openai : new TestProvider(mcpGenerator()),
        mcpClientFactory,
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
