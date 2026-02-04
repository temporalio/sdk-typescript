/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Manual tests to inspect tracing output
 */
import * as http2 from 'http2';
import * as otelApi from '@opentelemetry/api';
import { SpanStatusCode, createTraceState } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import type * as workflowImportStub from '@temporalio/interceptors-opentelemetry/lib/workflow/workflow-imports';
import type * as workflowImportImpl from '@temporalio/interceptors-opentelemetry/lib/workflow/workflow-imports-impl';
import { WorkflowClient, WithStartWorkflowOperation, WorkflowClientInterceptor } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '@temporalio/interceptors-opentelemetry';
import { instrument } from '@temporalio/interceptors-opentelemetry/lib/instrumentation';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/worker';
import {
  OpenTelemetrySinks,
  SpanName,
  SPAN_DELIMITER,
  OpenTelemetryOutboundInterceptor,
  OpenTelemetryInboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/workflow';
import {
  ActivityInboundCallsInterceptor,
  ActivityOutboundCallsInterceptor,
  DefaultLogger,
  InjectedSinks,
  Runtime,
} from '@temporalio/worker';
import { WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor } from '@temporalio/workflow';
import * as activities from './activities';
import { loadHistory, RUN_INTEGRATION_TESTS, Worker } from './helpers';
import * as workflows from './workflows';
import { createTestWorkflowBundle } from './helpers-integration';

async function withFakeGrpcServer(
  fn: (port: number) => Promise<void>,
  requestListener?: (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const srv = http2.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      srv.on('request', async (req, res) => {
        if (requestListener) await requestListener(req, res);
        res.statusCode = 200;
        res.addTrailers({
          'grpc-status': '0',
          'grpc-message': 'OK',
        });
        res.write(
          // This is a raw gRPC response, of length 0
          new Uint8Array([
            // Frame Type: Data; Not Compressed
            0,
            // Message Length: 0
            0, 0, 0, 0,
          ])
        );
        res.end();
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => {
          resolve();

          // The OTel exporter will try to flush metrics on drop, which may result in tons of ERROR
          // messages on the console if the server has had time to complete shutdown before then.
          // Delaying closing the server by 1 second is enough to avoid that situation, and doesn't
          // need to be awaited, no that doesn't slow down tests.
          setTimeout(() => {
            srv.close();
          }, 1000).unref();
        });
    });
  });
}

if (RUN_INTEGRATION_TESTS) {
  test.serial('Otel interceptor spans are connected and complete', async (t) => {
    Runtime.install({});
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
      otel.start();

      const sinks: InjectedSinks<OpenTelemetrySinks> = {
        exporter: makeWorkflowExporter(new SimpleSpanProcessor(traceExporter), staticResource),
      };

      const worker = await Worker.create({
        workflowsPath: require.resolve('./workflows'),
        activities,
        taskQueue: 'test-otel',
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
      await worker.runUntil(client.execute(workflows.smorgasbord, { taskQueue: 'test-otel', workflowId: uuid4() }));
      await otel.shutdown();
      const originalSpan = spans.find(({ name }) => name === `${SpanName.WORKFLOW_START}${SPAN_DELIMITER}smorgasbord`);
      t.true(originalSpan !== undefined);
      t.log(
        spans.map((span) => ({ name: span.name, parentSpanId: span.parentSpanId, spanId: span.spanContext().spanId }))
      );

      const firstExecuteSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}smorgasbord` &&
          parentSpanId === originalSpan?.spanContext().spanId
      );
      t.true(firstExecuteSpan !== undefined);
      t.true(firstExecuteSpan!.status.code === SpanStatusCode.OK);

      const continueAsNewSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.CONTINUE_AS_NEW}${SPAN_DELIMITER}smorgasbord` &&
          parentSpanId === firstExecuteSpan?.spanContext().spanId
      );
      t.true(continueAsNewSpan !== undefined);
      t.true(continueAsNewSpan!.status.code === SpanStatusCode.OK);

      const parentExecuteSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}smorgasbord` &&
          parentSpanId === continueAsNewSpan?.spanContext().spanId
      );
      t.true(parentExecuteSpan !== undefined);
      const firstActivityStartSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}fakeProgress` &&
          parentSpanId === parentExecuteSpan?.spanContext().spanId
      );
      t.true(firstActivityStartSpan !== undefined);

      const firstActivityExecuteSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}fakeProgress` &&
          parentSpanId === firstActivityStartSpan?.spanContext().spanId
      );
      t.true(firstActivityExecuteSpan !== undefined);

      const secondActivityStartSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}queryOwnWf` &&
          parentSpanId === parentExecuteSpan?.spanContext().spanId
      );
      t.true(secondActivityStartSpan !== undefined);

      const secondActivityExecuteSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}queryOwnWf` &&
          parentSpanId === secondActivityStartSpan?.spanContext().spanId
      );
      t.true(secondActivityExecuteSpan !== undefined);

      const childWorkflowStartSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.CHILD_WORKFLOW_START}${SPAN_DELIMITER}signalTarget` &&
          parentSpanId === parentExecuteSpan?.spanContext().spanId
      );
      t.true(childWorkflowStartSpan !== undefined);

      const childWorkflowExecuteSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}signalTarget` &&
          parentSpanId === childWorkflowStartSpan?.spanContext().spanId
      );
      t.true(childWorkflowExecuteSpan !== undefined);

      const signalChildWithUnblockSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}unblock` &&
          parentSpanId === parentExecuteSpan?.spanContext().spanId
      );
      t.true(signalChildWithUnblockSpan !== undefined);

      const localActivityStartSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}echo` &&
          parentSpanId === parentExecuteSpan?.spanContext().spanId
      );
      t.true(localActivityStartSpan !== undefined);

      const localActivityExecuteSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}echo` &&
          parentSpanId === localActivityStartSpan?.spanContext().spanId
      );
      t.true(localActivityExecuteSpan !== undefined);

      const activityStartedSignalSpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}activityStarted` &&
          parentSpanId === firstActivityExecuteSpan?.spanContext().spanId
      );
      t.true(activityStartedSignalSpan !== undefined);

      const querySpan = spans.find(
        ({ name, parentSpanId }) =>
          name === `${SpanName.WORKFLOW_QUERY}${SPAN_DELIMITER}step` &&
          parentSpanId === secondActivityExecuteSpan?.spanContext().spanId
      );
      t.true(querySpan !== undefined);

      t.deepEqual(new Set(spans.map((span) => span.spanContext().traceId)).size, 1);
    } finally {
      // Cleanup the runtime so that it doesn't interfere with other tests
      await Runtime._instance?.shutdown();
    }
  });

  // FIXME: This tests take ~9 seconds to complete on my local machine, even
  //        more in CI, and yet, it doesn't really do any assertion by itself.
  //        To be revisited at a later time.
  test.skip('Otel spans connected', async (t) => {
    const logger = new DefaultLogger('DEBUG');
    Runtime.install({
      logger,
    });
    try {
      const oTelUrl = 'http://127.0.0.1:4317';
      const exporter = new OTLPTraceExporter({ url: oTelUrl });
      const staticResource = new opentelemetry.resources.Resource({
        [SEMRESATTRS_SERVICE_NAME]: 'ts-test-otel-worker',
      });
      const otel = new opentelemetry.NodeSDK({
        resource: staticResource,
        traceExporter: exporter,
      });
      await otel.start();

      const sinks: InjectedSinks<OpenTelemetrySinks> = {
        exporter: makeWorkflowExporter(new SimpleSpanProcessor(exporter), staticResource),
      };
      const worker = await Worker.create({
        workflowsPath: require.resolve('./workflows'),
        activities,
        enableSDKTracing: true,
        taskQueue: 'test-otel',
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) })],
        },
        sinks,
      });

      const client = new WorkflowClient({
        interceptors: [new OpenTelemetryWorkflowClientInterceptor()],
      });
      await worker.runUntil(client.execute(workflows.smorgasbord, { taskQueue: 'test-otel', workflowId: uuid4() }));
      // Allow some time to ensure spans are flushed out to collector
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      t.pass();
    } finally {
      // Cleanup the runtime so that it doesn't interfere with other tests
      await Runtime._instance?.shutdown();
    }
  });

  test('Otel workflow module does not patch node window object', (t) => {
    // Importing the otel workflow modules above should patch globalThis
    t.falsy((globalThis as any).window);
  });

  test('instrumentation: Error status includes message and records exception', async (t) => {
    const memoryExporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    provider.register();
    const tracer = provider.getTracer('test-error-tracer');

    const errorMessage = 'Test error message';

    await t.throwsAsync(
      instrument({
        tracer,
        spanName: 'test-error-span',
        fn: async () => {
          throw new Error(errorMessage);
        },
      }),
      { message: errorMessage }
    );

    const spans = memoryExporter.getFinishedSpans();
    t.is(spans.length, 1);

    const span = spans[0];

    t.is(span.status.code, SpanStatusCode.ERROR);

    t.is(span.status.message, errorMessage);

    const exceptionEvents = span.events.filter((event) => event.name === 'exception');
    t.is(exceptionEvents.length, 1);
  });

  test('Otel workflow omits ApplicationError with BENIGN category', async (t) => {
    const memoryExporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    provider.register();
    const tracer = provider.getTracer('test-error-tracer');

    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test-otel-benign-err',
      interceptors: {
        activity: [
          (ctx) => {
            return { inbound: new OpenTelemetryActivityInboundInterceptor(ctx, { tracer }) };
          },
        ],
      },
    });

    const client = new WorkflowClient();

    await worker.runUntil(
      client.execute(workflows.throwMaybeBenignErr, {
        taskQueue: 'test-otel-benign-err',
        workflowId: uuid4(),
        retry: { maximumAttempts: 3 },
      })
    );

    const spans = memoryExporter.getFinishedSpans();
    t.is(spans.length, 3);
    t.is(spans[0].status.code, SpanStatusCode.ERROR);
    t.is(spans[0].status.message, 'not benign');
    t.is(spans[1].status.code, SpanStatusCode.UNSET);
    t.is(spans[1].status.message, 'benign');
    t.is(spans[2].status.code, SpanStatusCode.OK);
  });

  test('executeUpdateWithStart works correctly with OTEL interceptors', async (t) => {
    const staticResource = new opentelemetry.resources.Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'ts-test-otel-worker',
    });
    const traceExporter: opentelemetry.tracing.SpanExporter = {
      export(_spans, resultCallback) {
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      async shutdown() {},
    };

    const sinks: InjectedSinks<OpenTelemetrySinks> = {
      exporter: makeWorkflowExporter(new SimpleSpanProcessor(traceExporter), staticResource),
    };

    const worker = await Worker.create({
      workflowBundle: await createTestWorkflowBundle({
        workflowsPath: require.resolve('./workflows'),
        workflowInterceptorModules: [require.resolve('./workflows/otel-interceptors')],
      }),
      activities,
      taskQueue: 'test-otel-update-start',
      interceptors: {
        client: {
          workflow: [new OpenTelemetryWorkflowClientCallsInterceptor()],
        },
        workflowModules: [require.resolve('./workflows/otel-interceptors')],
      },
      sinks,
    });

    const client = new WorkflowClient();

    const startWorkflowOperation = new WithStartWorkflowOperation(workflows.updateStartOtel, {
      workflowId: uuid4(),
      taskQueue: 'test-otel-update-start',
      workflowIdConflictPolicy: 'FAIL',
    });

    const { updateResult, workflowResult } = await worker.runUntil(async () => {
      const updateResult = await client.executeUpdateWithStart(workflows.otelUpdate, {
        args: [true],
        startWorkflowOperation,
      });

      const handle = await startWorkflowOperation.workflowHandle();
      const workflowResult = await handle.result();

      return { updateResult, workflowResult };
    });

    t.is(updateResult, true);
    t.is(workflowResult, true);
  });

  // These tests verify makeWorkflowExporter's handling of async resource attributes:
  // https://github.com/temporalio/sdk-typescript/issues/1779
  // - Using SpanExporter directly: async attributes are not awaited
  // - Using SpanProcessor: async attributes are awaited before export
  for (const useSpanProcessor of [false, true]) {
    test(`makeWorkflowExporter with ${
      useSpanProcessor ? 'SpanProcessor does' : 'SpanExporter does not'
    } await async resource attributes`, async (t) => {
      const taskQueue = `test-otel-async-${useSpanProcessor ? 'processor' : 'exporter'}`;
      const serviceName = `ts-test-otel-async-attributes`;

      // Create a promise for async attributes that we control.
      // If not using a span processor it will never resolve.
      let resolveAsyncAttrs: (attrs: opentelemetry.resources.ResourceAttributes) => void;
      const asyncAttributesPromise = new Promise<opentelemetry.resources.ResourceAttributes>((resolve) => {
        resolveAsyncAttrs = resolve;
      });

      const resource = new opentelemetry.resources.Resource(
        { [SEMRESATTRS_SERVICE_NAME]: serviceName },
        asyncAttributesPromise
      );

      const spans: opentelemetry.tracing.ReadableSpan[] = [];
      const traceExporter: opentelemetry.tracing.SpanExporter = {
        export(spans_, resultCallback) {
          spans.push(...spans_);
          resultCallback({ code: ExportResultCode.SUCCESS });
        },
        async shutdown() {},
      };

      // Custom SpanProcessor that resolves async resource attributes after the first onEnd is called.
      // SpanProcessors are expected to wait on async resource attributes to settle before exporting the span.
      class TestSpanProcessor extends SimpleSpanProcessor {
        override onEnd(span: opentelemetry.tracing.ReadableSpan): void {
          super.onEnd(span);
          // Resolve async attributes so waitForAsyncAttributes can complete
          resolveAsyncAttrs({ 'async.attr': 'resolved' });
        }
      }

      const sinks: InjectedSinks<OpenTelemetrySinks> = {
        exporter: useSpanProcessor
          ? makeWorkflowExporter(new TestSpanProcessor(traceExporter), resource)
          : makeWorkflowExporter(traceExporter, resource),
      };

      const worker = await Worker.create({
        workflowsPath: require.resolve('./workflows'),
        activities,
        taskQueue,
        interceptors: {
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

      const client = new WorkflowClient();
      await worker.runUntil(client.execute(workflows.successString, { taskQueue, workflowId: uuid4() }));

      t.deepEqual(spans[0].resource.attributes, {
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        // If not using a span processor, then we do not expect the async attr to be present
        ...(useSpanProcessor ? { 'async.attr': 'resolved' } : {}),
      });
    });
  }

  // Regression test for https://github.com/temporalio/sdk-typescript/issues/1738
  test.serial('traceState properly crosses V8 isolate boundary', async (t) => {
    const exportErrors: Error[] = [];
    // Collect spans exported from workflow (those that crossed the isolate boundary)
    const workflowExportedSpans: opentelemetry.tracing.ReadableSpan[] = [];

    await withFakeGrpcServer(async (port) => {
      const staticResource = new opentelemetry.resources.Resource({
        [SEMRESATTRS_SERVICE_NAME]: 'test-tracestate-issue-1738',
      });

      const traceExporter = new OTLPTraceExporter({ url: `http://127.0.0.1:${port}` });

      // Wrap the exporter to catch errors
      const wrappedExporter: opentelemetry.tracing.SpanExporter = {
        export(spans, resultCallback) {
          traceExporter.export(spans, (result) => {
            if (result.code === ExportResultCode.FAILED && result.error) {
              exportErrors.push(result.error);
            }
            resultCallback(result);
          });
        },
        async shutdown() {
          await traceExporter.shutdown();
        },
      };

      // Create a separate exporter for workflow spans that captures them for inspection
      const workflowSpanExporter: opentelemetry.tracing.SpanExporter = {
        export(spans, resultCallback) {
          // Capture spans for later inspection
          workflowExportedSpans.push(...spans);
          // Also send to the real exporter to test serialization
          wrappedExporter.export(spans, resultCallback);
        },
        async shutdown() {
          await wrappedExporter.shutdown();
        },
      };

      const otel = new opentelemetry.NodeSDK({
        resource: staticResource,
        traceExporter: wrappedExporter,
      });
      otel.start();

      const sinks: InjectedSinks<OpenTelemetrySinks> = {
        exporter: makeWorkflowExporter(workflowSpanExporter, staticResource),
      };

      const worker = await Worker.create({
        workflowsPath: require.resolve('./workflows'),
        activities,
        taskQueue: 'test-otel-tracestate',
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
        },
        sinks,
      });

      const client = new WorkflowClient({
        interceptors: [new OpenTelemetryWorkflowClientInterceptor()],
      });

      // Create a parent span with traceState and run the workflow within that context
      const tracer = otelApi.trace.getTracer('test-tracestate');

      await worker.runUntil(async () => {
        // Create a span with traceState by starting a span and then creating a new context with traceState
        const parentSpan = tracer.startSpan('parent-with-tracestate');
        const parentContext = otelApi.trace.setSpan(otelApi.context.active(), parentSpan);

        // Get the span context and create a new one with traceState
        const originalSpanContext = parentSpan.spanContext();
        const traceState = createTraceState('vendor1=value1,vendor2=value2');
        const spanContextWithTraceState = {
          ...originalSpanContext,
          traceState,
        };

        // Create a new context with the modified span context
        const contextWithTraceState = otelApi.trace.setSpanContext(parentContext, spanContextWithTraceState);

        // Execute the workflow within this context so the traceState is propagated
        await otelApi.context.with(contextWithTraceState, async () => {
          await client.execute(workflows.successString, {
            taskQueue: 'test-otel-tracestate',
            workflowId: uuid4(),
          });
        });

        parentSpan.end();
      });

      await otel.shutdown();
    });

    t.deepEqual(exportErrors, [], 'should have no errors exporting spans');

    const traceStates = workflowExportedSpans.map((span) => span.spanContext().traceState).filter(Boolean);
    t.assert(traceStates.length > 0, 'Should have spans with traceState');

    // Verify the traceState was properly reconstructed with working methods
    for (const traceState of traceStates) {
      // Verify serialize() method works and returns expected value
      const serialized = traceState!.serialize();
      t.is(serialized, 'vendor1=value1,vendor2=value2');
      t.is(traceState!.get('vendor1'), 'value1');
      t.is(traceState!.get('vendor2'), 'value2');
    }
  });
}

test('Can replay otel history from 1.11.3', async (t) => {
  const hist = await loadHistory('otel_1_11_3.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory(
      {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: require.resolve('./workflows/signal-start-otel'),
          workflowInterceptorModules: [require.resolve('./workflows/signal-start-otel')],
        }),
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [
            (ctx) => ({
              inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
            }),
          ],
        },
      },
      hist
    );
  });
});

test('Can replay otel history from 1.13.1', async (t) => {
  const hist = await loadHistory('otel_1_13_1.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory(
      {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: require.resolve('./workflows/signal-start-otel'),
          workflowInterceptorModules: [require.resolve('./workflows/signal-start-otel')],
        }),
        interceptors: {
          workflowModules: [require.resolve('./workflows/signal-start-otel')],
          activity: [
            (ctx) => ({
              inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
            }),
          ],
        },
      },
      hist
    );
  });
});

test('Can replay smorgasbord from 1.13.1', async (t) => {
  // This test will trigger NDE if yield points for `scheduleActivity` and `startChildWorkflowExecution` are not inserted
  const hist = await loadHistory('otel_smorgasbord_1_13_1.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory(
      {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: require.resolve('./workflows'),
          workflowInterceptorModules: [require.resolve('./workflows/otel-interceptors')],
        }),
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [
            (ctx) => ({
              inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
            }),
          ],
        },
      },
      hist
    );
  });
});

test('Can replay signal workflow from 1.13.1', async (t) => {
  const hist = await loadHistory('signal_workflow_1_13_1.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory(
      {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: require.resolve('./workflows/signal-workflow'),
          workflowInterceptorModules: [require.resolve('./workflows/otel-interceptors')],
        }),
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [
            (ctx) => ({
              inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
            }),
          ],
        },
      },
      hist
    );
  });
});

test('Can replay smorgasbord from 1.13.2', async (t) => {
  const hist = await loadHistory('otel_smorgasbord_1_13_2.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory(
      {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: require.resolve('./workflows'),
          workflowInterceptorModules: [require.resolve('./workflows/otel-interceptors')],
        }),
        interceptors: {
          workflowModules: [require.resolve('./workflows/otel-interceptors')],
          activity: [
            (ctx) => ({
              inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
              outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
            }),
          ],
        },
      },
      hist
    );
  });
});

// Skipped as we only care that it compiles
test.skip('otel interceptors are complete', async (t) => {
  // We only use this to verify that we trace all spans via typechecking
  // Doing this instead of directly changing the `implements` to avoid leaking this in the docs
  const _wfl_inbound = {} as OpenTelemetryInboundInterceptor satisfies Required<WorkflowInboundCallsInterceptor>;
  const _wfl_outbound = {} as OpenTelemetryOutboundInterceptor satisfies Required<
    Omit<WorkflowOutboundCallsInterceptor, 'startTimer'>
  >;
  const _act_inbound =
    {} as OpenTelemetryActivityInboundInterceptor satisfies Required<ActivityInboundCallsInterceptor>;
  const _act_outbound =
    {} as OpenTelemetryActivityOutboundInterceptor satisfies Required<ActivityOutboundCallsInterceptor>;
  const _client = {} as OpenTelemetryWorkflowClientInterceptor satisfies Required<WorkflowClientInterceptor>;
  t.pass();
});

test.skip('workflow-imports stub and impl have same type', async (t) => {
  const _implSatisfiesStub = {} as typeof workflowImportImpl satisfies typeof workflowImportStub;
  const _stubSatisfiesImpl = {} as typeof workflowImportStub satisfies typeof workflowImportImpl;
  t.pass();
});
