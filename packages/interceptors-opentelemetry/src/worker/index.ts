import * as otel from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ApplyMode,
  DataConverter,
  defaultDataConverter,
  InjectedDependency,
  Next,
} from '@temporalio/worker';
import { OpenTelemetryWorkflowExporter, SerializableSpan, SpanName } from '../workflow';
import { instrumentFromSpanContext } from '../instrumentation';
import { extractSpanContextFromHeaders } from '@temporalio/common';

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
    const spanContext = await extractSpanContextFromHeaders(input.headers);
    if (spanContext === undefined) {
      return await next(input);
    }
    return await instrumentFromSpanContext(this.tracer, spanContext, SpanName.ACTIVITY_EXECUTE, () => next(input));
  }
}

/**
 * Takes an opentelemetry SpanExporter and turns it into an injected Workflow span exporter dependency
 */
export function makeWorkflowExporter(
  exporter: SpanExporter,
  resource?: Resource
): InjectedDependency<OpenTelemetryWorkflowExporter> {
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
      applyMode: ApplyMode.ASYNC_IGNORED,
    },
  };
}

/**
 * Deserialize a serialized span created by the Workflow isolate
 */
function extractReadableSpan(serializable: SerializableSpan, resource?: Resource): ReadableSpan {
  const { spanContext, ...rest } = serializable;
  return {
    spanContext() {
      return spanContext;
    },
    resource: resource ?? Resource.EMPTY,
    ...rest,
  };
}
