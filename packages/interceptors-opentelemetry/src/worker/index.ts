import * as otel from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan, SpanExporter } from '@opentelemetry/tracing';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ApplyMode,
  DataConverter,
  defaultDataConverter,
  InjectedDependency,
  Next,
} from '@temporalio/worker';
import { TRACE_HEADER, OpenTelemetryWorkflowExporter, SerializableSpan, SpanName } from '../workflow';
import { instrumentFromSpanContext } from '../instrumentation';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
  readonly dataConverter?: DataConverter;
}

/**
 * Intercepts calls to start an Activity.
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Activity input headers.
 */
export class OpenTelemetryActivityInboundInterceptor implements ActivityInboundCallsInterceptor {
  protected readonly tracer: otel.Tracer;
  protected readonly dataConverter: DataConverter;

  constructor(options?: InterceptorOptions) {
    this.dataConverter = options?.dataConverter ?? defaultDataConverter;
    this.tracer = options?.tracer ?? otel.trace.getTracer('activity');
  }

  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const encodedSpanContext = input.headers.get(TRACE_HEADER);
    const spanContext: otel.SpanContext | undefined = encodedSpanContext
      ? await this.dataConverter.fromPayload(encodedSpanContext)
      : undefined;
    if (spanContext === undefined) {
      return await next(input);
    }
    return await instrumentFromSpanContext(this.tracer, spanContext, SpanName.ACTIVITY_EXECUTE, () => next(input));
  }
}

/**
 * Deserialize a serialized span created by the Workflow isolate
 */
function extractReadableSpan(serializable: SerializableSpan): ReadableSpan {
  const { spanContext, ...rest } = serializable;
  return {
    spanContext() {
      return spanContext;
    },
    ...rest,
  };
}

/**
 * Takes an opentelemetry SpanExporter and turns it into an injected Workflow span exporter dependency
 */
export function makeWorkflowExporter(exporter: SpanExporter): InjectedDependency<OpenTelemetryWorkflowExporter> {
  return {
    export: {
      fn: (info, spanData) => {
        const spans = spanData.map((serialized) => {
          Object.assign(serialized.attributes, info);
          // Spans are copied over from the isolate and are converted to ReadableSpan instances
          return extractReadableSpan(serialized);
        });
        // Ignore the export result for simplicity
        exporter.export(spans, () => undefined);
      },
      applyMode: ApplyMode.ASYNC_IGNORED,
    },
  };
}
