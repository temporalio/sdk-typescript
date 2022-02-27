/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Manual tests to inspect tracing output
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Core, DefaultLogger, InjectedSinks, Worker } from '@temporalio/worker';
import { ExportResultCode } from '@opentelemetry/core';
import { CollectorTraceExporter } from '@opentelemetry/exporter-collector-grpc';

import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { WorkflowClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/worker';
import { OpenTelemetrySinks, SpanName, SPAN_DELIMITER } from '@temporalio/interceptors-opentelemetry/lib/workflow';

import * as activities from './activities';
import * as workflows from './workflows';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { SpanStatusCode } from '@opentelemetry/api';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Otel interceptor spans are connected and complete', async (t) => {
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
    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test-otel',
      interceptors: {
        workflowModules: [require.resolve('./workflows/otel-interceptors')],
        activityInbound: [(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx)],
      },
      sinks,
    });

    const client = new WorkflowClient(undefined, {
      interceptors: {
        calls: [() => new OpenTelemetryWorkflowClientCallsInterceptor()],
      },
    });
    await Promise.all([
      client
        .execute(workflows.smorgasbord, { taskQueue: 'test-otel', workflowId: uuid4() })
        .finally(() => worker.shutdown()),
      worker.run(),
    ]);
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
  test.serial.skip('Otel spans connected', async (t) => {
    const oTelUrl = 'grpc://localhost:4317';
    const exporter = new CollectorTraceExporter({ url: oTelUrl });
    const staticResource = new opentelemetry.resources.Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'ts-test-otel-worker',
    });
    const otel = new opentelemetry.NodeSDK({
      resource: staticResource,
      traceExporter: exporter,
    });
    await otel.start();

    const logger = new DefaultLogger('DEBUG');
    await Core.install({
      logger,
      telemetryOptions: {
        oTelCollectorUrl: oTelUrl,
        tracingFilter: 'temporal_sdk_core=DEBUG',
        logForwardingLevel: 'INFO',
      },
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
        activityInbound: [(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx)],
      },
      sinks,
    });

    const client = new WorkflowClient(undefined, {
      interceptors: {
        calls: [() => new OpenTelemetryWorkflowClientCallsInterceptor()],
      },
    });
    await Promise.all([
      client
        .execute(workflows.cancelFakeProgress, { taskQueue: 'test-otel', workflowId: uuid4() })
        .finally(() => worker.shutdown()),
      worker.run(),
    ]);
    // Allow some time to ensure spans are flushed out to collector
    await new Promise((resolve) => setTimeout(resolve, 5000));
    t.pass();
  });
}
