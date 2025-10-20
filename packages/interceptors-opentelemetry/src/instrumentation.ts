/**
 * opentelemetry instrumentation helper functions
 * @module
 */
import * as otel from '@opentelemetry/api';
import {
  type Headers,
  ApplicationFailure,
  ApplicationFailureCategory,
  defaultPayloadConverter,
} from '@temporalio/common';

/** Default trace header for opentelemetry interceptors */
export const TRACE_HEADER = '_tracer-data';
/** As in workflow run id */
export const RUN_ID_ATTR_KEY = 'run_id';

const payloadConverter = defaultPayloadConverter;

/**
 * If found, return an otel Context deserialized from the provided headers
 */
export function extractContextFromHeaders(headers: Headers): otel.Context | undefined {
  const encodedSpanContext = headers[TRACE_HEADER];
  if (encodedSpanContext === undefined) {
    return undefined;
  }
  const textMap: Record<string, string> = payloadConverter.fromPayload(encodedSpanContext);
  return otel.propagation.extract(otel.context.active(), textMap, otel.defaultTextMapGetter);
}

/**
 * Given headers, return new headers with the current otel context inserted
 */
export async function headersWithContext(headers: Headers): Promise<Headers> {
  const carrier = {};
  otel.propagation.inject(otel.context.active(), carrier, otel.defaultTextMapSetter);
  return { ...headers, [TRACE_HEADER]: payloadConverter.toPayload(carrier) };
}

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
    const isBenignErr = err instanceof ApplicationFailure && err.category === ApplicationFailureCategory.BENIGN;
    if (acceptableErrors === undefined || !acceptableErrors(err)) {
      const statusCode = isBenignErr ? otel.SpanStatusCode.UNSET : otel.SpanStatusCode.ERROR;
      span.setStatus({ code: statusCode, message: (err as Error).message ?? String(err) });
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
