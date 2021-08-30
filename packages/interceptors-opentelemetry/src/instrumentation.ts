/**
 * opentelemetry instrumentation helper functions
 * @module
 */
import * as otel from '@opentelemetry/api';
import { errorMessage } from '@temporalio/common';

/**
 * Wraps `fn` in a span which ends when function returns or throws
 */
export async function instrument<T>(
  tracer: otel.Tracer,
  name: string,
  fn: (span: otel.Span) => Promise<T>
): Promise<T> {
  const parentContext = otel.context.active();
  const span = tracer.startSpan(name, undefined);
  const contextWithSpanSet = otel.trace.setSpan(parentContext, span);

  return otel.context.with(contextWithSpanSet, async () => {
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

/**
 * Instrument `fn` and set parent span context
 */
export async function instrumentFromSpanContext<T>(
  tracer: otel.Tracer,
  parent: otel.SpanContext,
  name: string,
  fn: (span: otel.Span) => Promise<T>
): Promise<T> {
  const context = otel.trace.setSpanContext(otel.context.active(), parent);
  return otel.context.with(context, async () => {
    return instrument(tracer, name, fn);
  });
}
