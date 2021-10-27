import * as otel from '@opentelemetry/api';
import { errorMessage } from '@temporalio/common';
import pkg from './pkg';

/**
 * A Span implementation which does nothing.
 *
 * Used to disable SDK tracing.
 */
class NoopSpan implements otel.Span {
  spanContext(): otel.SpanContext {
    return {
      traceId: 'DISABLED',
      spanId: 'DISABLED',
      traceFlags: otel.TraceFlags.SAMPLED,
    };
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  end(): void {
    // Noop
  }
  isRecording(): boolean {
    return false;
  }
  recordException(): void {
    // Noop
  }
}

const noopSpan = new NoopSpan();

/**
 * A Tracer implementation which does nothing.
 *
 * Used to disable SDK tracing.
 */
class NoopTracer implements otel.Tracer {
  startSpan(): otel.Span {
    return noopSpan;
  }

  startActiveSpan<F extends (span: otel.Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: otel.Span) => unknown>(
    name: string,
    options: otel.SpanOptions,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: otel.Span) => unknown>(
    name: string,
    options: otel.SpanOptions,
    context: otel.Context,
    fn: F
  ): ReturnType<F>;

  startActiveSpan<F extends (span: otel.Span) => unknown>(
    _name: any,
    optionsOrContextOrFn: any,
    contextOrFn?: any,
    fn?: any
  ): ReturnType<F> {
    if (fn != null) {
      return fn();
    }
    if (contextOrFn != null) {
      return contextOrFn();
    }
    return optionsOrContextOrFn();
  }
}

/**
 * Get either an opentelemetry tracer or a NoopTracer based on the `enabled` param.
 */
export function getTracer(enabled: boolean): otel.Tracer {
  if (enabled) {
    return otel.trace.getTracer(pkg.name, pkg.version);
  }
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
