import * as otel from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { Context as ActivityContext } from '@temporalio/activity';
import type {
  Next,
  ActivityInboundCallsInterceptor,
  ActivityOutboundCallsInterceptor,
  InjectedSink,
  GetLogAttributesInput,
  GetMetricTagsInput,
  ActivityExecuteInput,
} from '@temporalio/worker';
import { instrument, extractContextFromHeaders } from '../instrumentation';
import { type OpenTelemetryWorkflowExporter, type SerializableSpan, SpanName, SPAN_DELIMITER } from '../workflow';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
}

/**
 * Intercepts calls to start an Activity.
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Activity input headers.
 */
export class OpenTelemetryActivityInboundInterceptor implements Required<ActivityInboundCallsInterceptor> {
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
    return await instrument({ tracer: this.tracer, spanName, fn: () => next(input), context });
  }
}

/**
 * Intercepts calls to emit logs and metrics from an Activity.
 *
 * Attach OpenTelemetry context tracing attributes to emitted log messages and metrics, if appropriate.
 */
export class OpenTelemetryActivityOutboundInterceptor implements Required<ActivityOutboundCallsInterceptor> {
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
}

/**
 * Takes an opentelemetry SpanExporter and turns it into an injected Workflow span exporter sink
 */
export function makeWorkflowExporter(
  exporter: SpanExporter,
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
        // Ignore the export result for simplicity
        exporter.export(spans, () => undefined);
      },
    },
  };
}

/**
 * Deserialize a serialized span created by the Workflow isolate
 */
function extractReadableSpan(serializable: SerializableSpan, resource: Resource): ReadableSpan {
  const { spanContext, ...rest } = serializable;
  return {
    spanContext() {
      return spanContext;
    },
    resource,
    ...rest,
  };
}
