/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Manual tests to inspect tracing output
 */
import * as http2 from 'http2';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection, WorkflowClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/worker';
import { OpenTelemetrySinks, SpanName, SPAN_DELIMITER } from '@temporalio/interceptors-opentelemetry/lib/workflow';
import { DefaultLogger, InjectedSinks, Runtime } from '@temporalio/worker';
import * as activities from './activities';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import { RUN_INTEGRATION_TESTS, TestWorkflowEnvironment, Worker } from './helpers';
import * as workflows from './workflows';

async function withHttp2Server(
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
        res.end();
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => srv.close((_) => resolve()));
    });
  });
}

test.serial('Runtime.install() throws meaningful error when passed invalid metrics.otel.url', async (t) => {
  t.throws(() => Runtime.install({ telemetryOptions: { metrics: { otel: { url: ':invalid' } } } }), {
    instanceOf: TypeError,
    message: /Invalid telemetryOptions.metrics.otel.url/,
  });
});

test.serial('Runtime.install() accepts metrics.otel.url without headers', async (t) => {
  try {
    Runtime.install({ telemetryOptions: { metrics: { otel: { url: 'http://127.0.0.1:1234' } } } });
    t.pass();
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

// FIXME: Core's OTLP exporter has become extremely noisy when exporting metrics but not getting a
// proper grpc response from the collector. I'm skipping this test until we can reimplement this using
// a more a more convincing mock collector. This has also coincided with one case where of CI integration
// tests hanged, though I don't know at this point etither that's related or just a coincidence.
// https://github.com/temporalio/sdk-typescript/issues/1495
test.serial.skip('Exporting OTEL metrics from Core works', async (t) => {
  let resolveCapturedRequest = (_req: http2.Http2ServerRequest) => undefined as void;
  const capturedRequest = new Promise<http2.Http2ServerRequest>((r) => (resolveCapturedRequest = r));
  await withHttp2Server(async (port: number) => {
    Runtime.install({
      telemetryOptions: {
        metrics: {
          otel: {
            url: `http://127.0.0.1:${port}`,
            headers: {
              'x-test-header': 'test-value',
            },
            metricsExportInterval: 10,
          },
        },
      },
    });

    const localEnv = await TestWorkflowEnvironment.createLocal();
    try {
      const worker = await Worker.create({
        connection: localEnv.nativeConnection,
        workflowsPath: require.resolve('./workflows'),
        taskQueue: 'test-otel',
      });
      const client = new WorkflowClient({
        connection: localEnv.connection,
      });
      await worker.runUntil(async () => {
        await client.execute(workflows.successString, {
          taskQueue: 'test-otel',
          workflowId: uuid4(),
        });
        const req = await Promise.race([
          capturedRequest,
          await new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
        ]);
        t.truthy(req);
        t.is(req?.url, '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export');
        t.is(req?.headers['x-test-header'], 'test-value');
      });
    } finally {
      await localEnv.teardown();
    }
  }, resolveCapturedRequest);
});

if (RUN_INTEGRATION_TESTS) {
  // FIXME: See comment above.
  // https://github.com/temporalio/sdk-typescript/issues/1495
  test.serial.skip('Otel interceptor spans are connected and complete', async (t) => {
    const spans = Array<opentelemetry.tracing.ReadableSpan>();

    const staticResource = new opentelemetry.resources.Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'ts-test-otel-worker',
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

    const connection = await Connection.connect();

    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test-otel',
      interceptors: {
        workflowModules: [require.resolve('./workflows/otel-interceptors')],
        activity: [
          (ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) }),
          () => ({ inbound: new ConnectionInjectorInterceptor(connection) }),
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
    t.true(new Set(spans.map((span) => span.spanContext().traceId)).size === 1);
  });

  // Un-skip this test and run it by hand to inspect outputted traces
  test.serial('Otel spans connected', async (t) => {
    const oTelUrl = 'http://127.0.0.1:4317';
    const exporter = new OTLPTraceExporter({ url: oTelUrl });
    const staticResource = new opentelemetry.resources.Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'ts-test-otel-worker',
    });
    const otel = new opentelemetry.NodeSDK({
      resource: staticResource,
      traceExporter: exporter,
    });
    await otel.start();

    const logger = new DefaultLogger('DEBUG');
    Runtime.install({
      logger,
    });
    const sinks: InjectedSinks<OpenTelemetrySinks> = {
      exporter: makeWorkflowExporter(exporter, staticResource),
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
  });

  test('Otel workflow module does not patch node window object', (t) => {
    // Importing the otel workflow modules above should patch globalThis
    t.falsy((globalThis as any).window);
  });
}
