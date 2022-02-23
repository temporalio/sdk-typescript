/**
 * opentelemetry instrumentation helper functions
 * @module
 */
import * as otel from '@opentelemetry/api';

async function wrapWithSpan<T>(
  span: otel.Span,
  fn: (span: otel.Span) => Promise<T>,
  acceptableErrors?: (err: unknown) => boolean
): Promise<T> {
  try {
    const ret = await fn(span);
    span.setStatus({ code: otel.SpanStatusCode.OK });
    return ret;
  } catch (err: any) {
    if (acceptableErrors === undefined || !acceptableErrors(err)) {
      span.setStatus({ code: otel.SpanStatusCode.ERROR });
      span.recordException(err);
    } else {
      span.setStatus({ code: otel.SpanStatusCode.OK });
    }
    throw err;
  } finally {
    span.end();
  }
}

export interface InstrumentOptions<T> {
  tracer: otel.Tracer;
  spanName: string;
  fn: (span: otel.Span) => Promise<T>;
  context?: otel.Context;
  acceptableErrors?: (err: unknown) => boolean;
}
/**
 * Wraps `fn` in a span which ends when function returns or throws
 */
export async function instrument<T>({
  tracer,
  spanName,
  fn,
  context,
  acceptableErrors,
}: InstrumentOptions<T>): Promise<T> {
  if (context) {
    return await otel.context.with(context, async () => {
      return await tracer.startActiveSpan(spanName, async (span) => await wrapWithSpan(span, fn, acceptableErrors));
    });
  }
  return await tracer.startActiveSpan(spanName, async (span) => await wrapWithSpan(span, fn, acceptableErrors));
}
