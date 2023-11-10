import * as otel from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Context as ActivityContext } from '@temporalio/activity';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  InjectedSink,
  Next,
} from '@temporalio/worker';
import { instrument, extractContextFromHeaders } from '../instrumentation';
import { OpenTelemetryWorkflowExporter, SerializableSpan, SpanName, SPAN_DELIMITER } from '../workflow';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
}

/**
 * Intercepts calls to start an Activity.
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Activity input headers.
 */
export class OpenTelemetryActivityInboundInterceptor implements ActivityInboundCallsInterceptor {
  static createFactory(options?: InterceptorOptions): ActivityInterceptorsFactory {
    return (ctx) => ({ inbound: [new OpenTelemetryActivityInboundInterceptor(ctx, options)] });
  }

  protected readonly tracer: otel.Tracer;

  constructor(protected readonly ctx: ActivityContext, options?: InterceptorOptions) {
    this.tracer = options?.tracer ?? otel.trace.getTracer('@temporalio/interceptor-activity');
  }

  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const context = await extractContextFromHeaders(input.headers);
    const spanName = `${SpanName.ACTIVITY_EXECUTE}${SPAN_DELIMITER}${this.ctx.info.activityType}`;
    return await instrument({ tracer: this.tracer, spanName, fn: () => next(input), context });
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
