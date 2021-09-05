import * as otel from '@opentelemetry/api';
import { errorMessage } from '@temporalio/common';
import pkg from './pkg';

export const tracer = otel.trace.getTracer(pkg.name, pkg.version);

/**
 * Conveience function for creating a child span from an existing span
 */
export function childSpan(parent: otel.Span, name: string, options?: otel.SpanOptions): otel.Span {
  const context = otel.trace.setSpan(otel.context.active(), parent);
  return tracer.startSpan(name, options, context);
}

/**
 * Wraps `fn` in a span which ends when function returns or throws
 */
export async function instrument<T>(parent: otel.Span, name: string, fn: (span: otel.Span) => Promise<T>): Promise<T> {
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
