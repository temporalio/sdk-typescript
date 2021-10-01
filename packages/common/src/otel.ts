import { isSpanContextValid, Span, SpanContext } from '@opentelemetry/api';
import { defaultDataConverter } from './converter/data-converter';
import { Headers } from './interceptors';

export const TRACE_HEADER = 'Otel-Trace-Context';
/** As in workflow run id */
export const RUN_ID_ATTR_KEY = 'run_id';
/** For a workflow or activity task */
export const TASK_TOKEN_ATTR_KEY = 'task_token';
/** Number of jobs in a workflow activation */
export const NUM_JOBS_ATTR_KEY = 'num_jobs';

/**
 * If found, return a span context deserialized from the provided headers
 */
export async function extractSpanContextFromHeaders(headers: Headers): Promise<SpanContext | undefined> {
  const encodedSpanContext = headers[TRACE_HEADER];
  if (encodedSpanContext === undefined) {
    return undefined;
  }
  const decoded: SpanContext = await defaultDataConverter.fromPayload(encodedSpanContext);
  if (isSpanContextValid(decoded)) {
    return decoded;
  }
  return undefined;
}

/**
 * Given a span context & headers, return new headers with the span context inserted
 */
export async function headersWithSpanContext(context: SpanContext, headers: Headers): Promise<Headers> {
  return { ...headers, [TRACE_HEADER]: await defaultDataConverter.toPayload(context) };
}

/**
 * Link a span to an maybe-existing span context
 */
export function linkSpans(fromSpan: Span, toContext?: SpanContext): void {
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
