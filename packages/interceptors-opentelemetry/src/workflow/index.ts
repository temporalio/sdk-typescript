import './runtime'; // Patch the Workflow isolate runtime for opentelemetry
import * as otel from '@opentelemetry/api';
import {
  ActivityInput,
  Next,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
} from '@temporalio/workflow';
import { extractSpanContextFromHeaders, headersWithSpanContext } from '@temporalio/common/lib/otel';
import { instrument, instrumentFromSpanContext } from '../instrumentation';
import { ContextManager } from './context-manager';
import { SpanExporter } from './span-exporter';
import { SpanName } from './interfaces';
import * as tracing from '@opentelemetry/sdk-trace-base';

export * from './interfaces';

let tracer: undefined | otel.Tracer = undefined;

function getTracer(): otel.Tracer {
  if (tracer === undefined) {
    const provider = new tracing.BasicTracerProvider();
    provider.addSpanProcessor(new tracing.SimpleSpanProcessor(new SpanExporter()));
    provider.register({ contextManager: new ContextManager() });

    tracer = otel.trace.getTracer('workflow');
  }
  return tracer;
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
    const spanContext = await extractSpanContextFromHeaders(input.headers);

    if (spanContext === undefined) {
      return await instrument(getTracer(), SpanName.WORKFLOW_EXECUTE, () => next(input));
    }
    return await instrumentFromSpanContext(getTracer(), spanContext, SpanName.WORKFLOW_EXECUTE, () => next(input));
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
    return await instrument(getTracer(), SpanName.ACTIVITY_SCHEUDLE, async (span) => {
      const headers = await headersWithSpanContext(span.spanContext(), input.headers);
      return next({
        ...input,
        headers,
      });
    });
  }
}
