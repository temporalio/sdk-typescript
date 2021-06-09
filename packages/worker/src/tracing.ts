import * as otel from '@opentelemetry/api';
// ../package.json is outside of the TS project rootDir which causes TS to complain about this import.
// We do not want to change the rootDir because it messes up the output structure.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

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
      span.setStatus({ code: otel.SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
