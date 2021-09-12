import './runtime'; // Patch the Workflow isolate runtime for opentelemetry
import * as otel from '@opentelemetry/api';
import * as tracing from '@opentelemetry/tracing';
import {
  ActivityInput,
  Next,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
} from '@temporalio/workflow';
import { defaultDataConverter } from '@temporalio/common';
import { instrument, instrumentFromSpanContext } from '../instrumentation';
import { ContextManager } from './context-manager';
import { SpanExporter } from './span-exporter';
import { SpanName } from './interfaces';

export * from './interfaces';

export const TRACE_HEADER = 'Otel-Trace-Context';

export const tracer = otel.trace.getTracer('workflow');

/**
 * Creates an opentelemetry tracer provider,
 * adds the Workflow span processor and registers the Workflow context manager.
 */
export function registerOpentelemetryTracerProvider(): void {
  const provider = new tracing.BasicTracerProvider();
  provider.addSpanProcessor(new tracing.SimpleSpanProcessor(new SpanExporter()));
  provider.register({ contextManager: new ContextManager() });
}

/**
 * Intercepts calls to run a Workflow
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Workflow input headers.
 */
export class OpenTelemetryInboundInterceptor implements WorkflowInboundCallsInterceptor {
  public async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, 'execute'>
  ): Promise<unknown> {
    const encodedSpanContext = input.headers.get(TRACE_HEADER);
    const spanContext: otel.SpanContext | undefined = encodedSpanContext
      ? await defaultDataConverter.fromPayload(encodedSpanContext)
      : undefined;

    if (spanContext === undefined) {
      return await instrument(tracer, SpanName.WORKFLOW_EXECUTE, () => next(input));
    }
    return await instrumentFromSpanContext(tracer, spanContext, SpanName.WORKFLOW_EXECUTE, () => next(input));
  }
}

/**
 * Intercepts outbound calls to schedule an Activity
 *
 * Wraps the operation in an opentelemetry Span and passes it to the Activity via headers.
 */
export class OpenTelemetryOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  public async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
  ): Promise<unknown> {
    return await instrument(tracer, SpanName.ACTIVITY_SCHEUDLE, async (span) => {
      input.headers.set(TRACE_HEADER, await defaultDataConverter.toPayload(span.spanContext()));
      return next(input);
    });
  }
}
