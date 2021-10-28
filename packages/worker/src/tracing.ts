import * as otel from '@opentelemetry/api';
import { NoopTracer } from '@opentelemetry/api/build/src/trace/NoopTracer';
import { errorMessage } from '@temporalio/common';
import pkg from './pkg';

/**
 * Get either an opentelemetry tracer or a NoopTracer based on the `enabled` param.
 */
export function getTracer(enabled: boolean): otel.Tracer {
  if (enabled) {
    return otel.trace.getTracer(pkg.name, pkg.version);
  }
  // otel.trace.
  return new NoopTracer();
}

/**
 * Conveience function for creating a child span from an existing span
 */
export function childSpan(tracer: otel.Tracer, parent: otel.Span, name: string, options?: otel.SpanOptions): otel.Span {
  const context = otel.trace.setSpan(otel.context.active(), parent);
  return tracer.startSpan(name, options, context);
}

/**
 * Wraps `fn` in a span which ends when function returns or throws
 */
export async function instrument<T>(
  tracer: otel.Tracer,
  parent: otel.Span,
  name: string,
  fn: (span: otel.Span) => Promise<T>
): Promise<T> {
  const context = otel.trace.setSpan(otel.context.active(), parent);
  return otel.context.with(context, async () => {
    const span = tracer.startSpan(name, undefined);
    try {
      const ret = await fn(span);
      span.setStatus({ code: otel.SpanStatusCode.OK });
      return ret;
    } catch (err) {
      span.setStatus({ code: otel.SpanStatusCode.ERROR, message: errorMessage(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
