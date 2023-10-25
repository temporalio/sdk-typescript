/**
 * opentelemetry instrumentation helper functions
 * @module
 */
import * as otel from '@opentelemetry/api';
import { Headers, defaultPayloadConverter } from '@temporalio/common';

/** Default trace header for opentelemetry interceptors */
export const TRACE_HEADER = '_tracer-data';
/** As in workflow run id */
export const RUN_ID_ATTR_KEY = 'run_id';
/** For a workflow or activity task */
export const TASK_TOKEN_ATTR_KEY = 'task_token';
/** Number of jobs in a workflow activation */
export const NUM_JOBS_ATTR_KEY = 'num_jobs';

const payloadConverter = defaultPayloadConverter;

/**
 * If found, return an otel Context deserialized from the provided headers
 */
export async function extractContextFromHeaders(headers: Headers): Promise<otel.Context | undefined> {
  const encodedSpanContext = headers[TRACE_HEADER];
  if (encodedSpanContext === undefined) {
    return undefined;
  }
  const textMap: Record<string, string> = payloadConverter.fromPayload(encodedSpanContext);
  return otel.propagation.extract(otel.context.active(), textMap, otel.defaultTextMapGetter);
}

/**
 * If found, return an otel SpanContext deserialized from the provided headers
 */
export async function extractSpanContextFromHeaders(headers: Headers): Promise<otel.SpanContext | undefined> {
  const context = await extractContextFromHeaders(headers);
  if (context === undefined) {
    return undefined;
  }

  return otel.trace.getSpanContext(context);
}

/**
 * Given headers, return new headers with the current otel context inserted
 */
export async function headersWithContext(headers: Headers): Promise<Headers> {
  const carrier = {};
  otel.propagation.inject(otel.context.active(), carrier, otel.defaultTextMapSetter);
  return { ...headers, [TRACE_HEADER]: payloadConverter.toPayload(carrier) };
}

/**
 * Link a span to an maybe-existing span context
 */
export function linkSpans(fromSpan: otel.Span, toContext?: otel.SpanContext): void {
  if (toContext !== undefined) {
    // TODO: I have to go around typescript because otel api 😢
    //  See https://github.com/open-telemetry/opentelemetry-js-api/issues/124
    const links = (fromSpan as any).links;
    if (links === undefined) {
      (fromSpan as any).links = [{ context: toContext }];
    } else {
      links.push({ context: toContext });
    }
  }
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
