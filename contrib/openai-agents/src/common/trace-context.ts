import * as otel from '@opentelemetry/api';
import {
  Trace,
  getCurrentTrace,
  getGlobalTraceProvider,
  withTraceContext,
  type CustomSpanData,
  type Span as AgentSpan,
  type SpanError,
} from '@openai/agents-core';
import type { AgentsSpanHeader } from './headers';
import { agentTraceIdToOtelTraceId } from './tracing-bridge';

export function withSpanAsCurrent<T>(span: unknown, fn: () => T): T {
  const trace = getCurrentTrace();
  if (!trace) return fn();
  return withTraceContext({ trace, span: span as AgentSpan<any> }, fn);
}

type SpanWithLifecycle = {
  start: () => void;
  end: () => void;
  setError: (e: SpanError) => void;
};

function recordSpanError<S extends SpanWithLifecycle>(span: S, e: unknown): void {
  const err = e as { message?: string; data?: Record<string, unknown> } | undefined;
  span.setError({ message: err?.message ?? String(e), data: err?.data as Record<string, any> | undefined });
}

export function withScopedSpan<S extends SpanWithLifecycle, T>(span: S, fn: () => T): T {
  try {
    span.start();
    const result = withSpanAsCurrent(span, fn);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (v) => {
          span.end();
          return v;
        },
        (e: unknown) => {
          recordSpanError(span, e);
          span.end();
          throw e;
        }
      ) as T;
    }
    span.end();
    return result;
  } catch (e: unknown) {
    recordSpanError(span, e);
    span.end();
    throw e;
  }
}

export function withRestoredAgentsTraceContext<T>(header: AgentsSpanHeader, fn: () => T): T {
  if (!header.traceId) return fn();
  const trace = new Trace({ traceId: header.traceId, name: header.traceName });
  const span = header.spanId
    ? getGlobalTraceProvider().createSpan<CustomSpanData>(
        { spanId: header.spanId, data: { type: 'custom', name: '', data: {} } },
        trace
      )
    : undefined;
  const restored = (): T => withTraceContext({ trace, span }, fn);
  if (!header.otelSpanId) return restored();

  const otelSpanContext: otel.SpanContext = {
    traceId: agentTraceIdToOtelTraceId(header.traceId),
    spanId: header.otelSpanId,
    traceFlags: otel.TraceFlags.SAMPLED,
    isRemote: true,
  };
  const ctx = otel.trace.setSpanContext(otel.context.active(), otelSpanContext);
  return otel.context.with(ctx, restored);
}

/**
 * Fresh ALS scope preserving current trace, clearing current span. Used by
 * inbound handlers (Signal/Query/Update) on the no-header path to prevent
 * outbound-span bleed: if the Workflow body is suspended inside an outbound
 * interceptor's `await next(input)`, the agent-SDK ALS frame still has that
 * outbound span as current, and an inbound handler firing then would emit
 * its `temporal:handle*` span as a child of the outbound Activity span.
 */
export function withIsolatedAgentsTraceContext<T>(fn: () => T): T {
  const trace = getCurrentTrace();
  if (!trace) return fn();
  return withTraceContext({ trace }, fn);
}
