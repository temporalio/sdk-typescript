import * as otel from '@opentelemetry/api';
import { Headers } from './interceptors';
import { defaultPayloadConverter } from './converter/payload-converter';

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
