import * as otel from '@opentelemetry/api';
import { createTraceState } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type * as nexus from 'nexus-rpc';
import type { Context as ActivityContext } from '@temporalio/activity';
import { CompleteAsyncError } from '@temporalio/common';
import type {
  Next,
  ActivityInboundCallsInterceptor,
  ActivityOutboundCallsInterceptor,
  NexusInboundCallsInterceptor,
  NexusOutboundCallsInterceptor,
  NexusStartOperationInput,
  NexusStartOperationOutput,
  NexusCancelOperationInput,
  InjectedSink,
  GetLogAttributesInput,
  GetMetricTagsInput,
  ActivityExecuteInput,
} from '@temporalio/worker';
import {
  instrument,
  extractContextFromHeaders,
  extractContextFromNexusHeaders,
  WORKFLOW_ID_ATTR_KEY,
  RUN_ID_ATTR_KEY,
  ACTIVITY_ID_ATTR_KEY,
  NEXUS_SERVICE_ATTR_KEY,
  NEXUS_OPERATION_ATTR_KEY,
} from '../instrumentation';
import {
  type OpenTelemetryWorkflowExporter,
  type SerializableSpan,
  SpanName,
  SPAN_DELIMITER,
} from '../workflow/definitions';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
}

/**
 * Intercepts calls to start an Activity.
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Activity input headers.
 *
 * @experimental This interceptor is experimental and APIs may change without notice.
 */
export class OpenTelemetryActivityInboundInterceptor implements ActivityInboundCallsInterceptor {
  protected readonly tracer: otel.Tracer;

  constructor(
    protected readonly ctx: ActivityContext,
    options?: InterceptorOptions
  ) {
    this.tracer = options?.tracer ?? otel.trace.getTracer('@temporalio/interceptor-activity');
  }

  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const context = extractContextFromHeaders(input.headers);
    const spanName = `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}${this.ctx.info.activityType}`;
    return await instrument({
      tracer: this.tracer,
      spanName,
      fn: (span) => {
        span.setAttribute(ACTIVITY_ID_ATTR_KEY, this.ctx.info.activityId);
        if (this.ctx.info.inWorkflow) {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, this.ctx.info.workflowExecution!.workflowId);
          span.setAttribute(RUN_ID_ATTR_KEY, this.ctx.info.workflowExecution!.runId);
        }
        return next(input);
      },
      context,
      acceptableErrors: (err) => err instanceof CompleteAsyncError,
    });
  }
}

/**
 * Intercepts calls to emit logs and metrics from an Activity.
 *
 * Attach OpenTelemetry context tracing attributes to emitted log messages, if appropriate.
 *
 * @experimental This interceptor is experimental and APIs may change without notice.
 */
export class OpenTelemetryActivityOutboundInterceptor implements ActivityOutboundCallsInterceptor {
  constructor(protected readonly ctx: ActivityContext) {}

  public getLogAttributes(
    input: GetLogAttributesInput,
    next: Next<ActivityOutboundCallsInterceptor, 'getLogAttributes'>
  ): Record<string, unknown> {
    const span = otel.trace.getSpan(otel.context.active());
    const spanContext = span?.spanContext();
    if (spanContext && otel.isSpanContextValid(spanContext)) {
      return next({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: `0${spanContext.traceFlags.toString(16)}`,
        ...input,
      });
    } else {
      return next(input);
    }
  }

  public getMetricTags(
    input: GetMetricTagsInput,
    next: Next<ActivityOutboundCallsInterceptor, 'getMetricTags'>
  ): GetMetricTagsInput {
    return next(input);
  }
}

/**
 * Intercepts inbound Nexus Operation calls on the worker.
 *
 * Wraps `startOperation` and `cancelOperation` in opentelemetry Spans, linking to a parent Span context
 * if one is provided in the Nexus request headers.
 *
 * @experimental This interceptor is experimental and APIs may change without notice.
 */
export class OpenTelemetryNexusInboundInterceptor implements NexusInboundCallsInterceptor {
  protected readonly tracer: otel.Tracer;

  constructor(
    protected readonly ctx: nexus.OperationContext,
    options?: InterceptorOptions
  ) {
    this.tracer = options?.tracer ?? otel.trace.getTracer('@temporalio/interceptor-nexus');
  }

  async startOperation(
    input: NexusStartOperationInput,
    next: Next<NexusInboundCallsInterceptor, 'startOperation'>
  ): Promise<NexusStartOperationOutput> {
    const context = extractContextFromNexusHeaders(input.ctx.headers);
    const spanName = `${SpanName.NEXUS_START_OPERATION_EXECUTE}${SPAN_DELIMITER}${input.ctx.service}/${input.ctx.operation}`;
    return await instrument({
      tracer: this.tracer,
      spanName,
      fn: (span) => {
        span.setAttribute(NEXUS_SERVICE_ATTR_KEY, input.ctx.service);
        span.setAttribute(NEXUS_OPERATION_ATTR_KEY, input.ctx.operation);
        return next(input);
      },
      context,
    });
  }

  async cancelOperation(
    input: NexusCancelOperationInput,
    next: Next<NexusInboundCallsInterceptor, 'cancelOperation'>
  ): Promise<void> {
    const context = extractContextFromNexusHeaders(input.ctx.headers);
    const spanName = `${SpanName.NEXUS_CANCEL_OPERATION_EXECUTE}${SPAN_DELIMITER}${input.ctx.service}/${input.ctx.operation}`;
    return await instrument({
      tracer: this.tracer,
      spanName,
      fn: (span) => {
        span.setAttribute(NEXUS_SERVICE_ATTR_KEY, input.ctx.service);
        span.setAttribute(NEXUS_OPERATION_ATTR_KEY, input.ctx.operation);
        return next(input);
      },
      context,
    });
  }
}

/**
 * Intercepts outbound calls from a Nexus Operation handler.
 *
 * Attaches OpenTelemetry context tracing attributes to emitted log messages.
 *
 * @experimental This interceptor is experimental and APIs may change without notice.
 */
export class OpenTelemetryNexusOutboundInterceptor implements NexusOutboundCallsInterceptor {
  constructor(protected readonly ctx: nexus.OperationContext) {}

  public getLogAttributes(
    input: GetLogAttributesInput,
    next: Next<NexusOutboundCallsInterceptor, 'getLogAttributes'>
  ): Record<string, unknown> {
    const span = otel.trace.getSpan(otel.context.active());
    const spanContext = span?.spanContext();
    if (spanContext && otel.isSpanContextValid(spanContext)) {
      return next({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: `0${spanContext.traceFlags.toString(16)}`,
        ...input,
      });
    } else {
      return next(input);
    }
  }

  public getMetricTags(
    input: GetMetricTagsInput,
    next: Next<NexusOutboundCallsInterceptor, 'getMetricTags'>
  ): GetMetricTagsInput {
    return next(input);
  }
}

/**
 * Takes an opentelemetry SpanProcessor and turns it into an injected Workflow span exporter sink.
 */
export function makeWorkflowExporter(
  spanProcessor: SpanProcessor,
  resource: Resource
): InjectedSink<OpenTelemetryWorkflowExporter>;
export function makeWorkflowExporter(
  processor: SpanProcessor,
  resource: Resource
): InjectedSink<OpenTelemetryWorkflowExporter> {
  return {
    export: {
      fn: (info, spanData) => {
        const spans = spanData.map((serialized) => {
          Object.assign(serialized.attributes, info);
          // Spans are copied over from the isolate and are converted to ReadableSpan instances
          return extractReadableSpan(serialized, resource);
        });

        spans.forEach((span) => processor.onEnd(span));
      },
    },
  };
}

/**
 * Deserialize a serialized span created by the Workflow isolate
 */
function extractReadableSpan(serializable: SerializableSpan, resource: Resource): ReadableSpan {
  const {
    spanContext: { traceState, ...restSpanContext },
    parentSpanContext: serializedParentSpanContext,
    instrumentationScope,
    ...rest
  } = serializable;
  const spanContext: otel.SpanContext = {
    // Reconstruct the TraceState from the serialized string.
    traceState: traceState ? createTraceState(traceState) : undefined,
    ...restSpanContext,
  };

  let parentSpanContext: otel.SpanContext | undefined;
  if (serializedParentSpanContext) {
    const { traceState: parentTraceState, ...restParentSpanContext } = serializedParentSpanContext;
    parentSpanContext = {
      traceState: parentTraceState ? createTraceState(parentTraceState) : undefined,
      ...restParentSpanContext,
    };
  }

  return {
    spanContext() {
      return spanContext;
    },
    parentSpanContext,
    instrumentationScope,
    resource,
    ...rest,
  };
}
