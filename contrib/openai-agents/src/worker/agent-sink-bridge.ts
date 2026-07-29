import {
  dispatchSpanEnd,
  dispatchSpanStart,
  getGlobalTraceProvider,
  Span,
  type Span as AgentSpan,
  type SpanData,
  type Trace as AgentTrace,
  type TracingProcessor,
} from '@openai/agents-core';
import type { InjectedSink } from '@temporalio/worker';
import type { AgentTracingSink, AgentTracingSinkEvent } from '../common/agent-sink-types';

const SUPPRESS_OTEL_BRIDGE = Symbol('@temporalio/openai-agents/suppress-otel-bridge');

export function markSuppressOtelBridge(obj: object): void {
  Object.defineProperty(obj, SUPPRESS_OTEL_BRIDGE, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export function isSuppressOtelBridge(obj: AgentSpan<SpanData> | AgentTrace): boolean {
  return (obj as unknown as Record<symbol, unknown>)[SUPPRESS_OTEL_BRIDGE] === true;
}

function dispatchTraceStart(event: Extract<AgentTracingSinkEvent, { kind: 'trace_start' }>): Promise<void> {
  const provider = getGlobalTraceProvider();
  const trace = provider.createTrace({
    traceId: event.trace.traceId,
    name: event.trace.name,
    groupId: event.trace.groupId ?? undefined,
    ...(event.trace.metadata != null ? { metadata: event.trace.metadata } : {}),
    ...(event.trace.tracingApiKey != null ? { tracingApiKey: event.trace.tracingApiKey } : {}),
  });
  if (!event.forwardToOtel) markSuppressOtelBridge(trace);
  return trace.start();
}

function dispatchTraceEnd(event: Extract<AgentTracingSinkEvent, { kind: 'trace_end' }>): Promise<void> {
  const provider = getGlobalTraceProvider();
  // `started: true` so `.end()` fires `onTraceEnd`; otherwise it no-ops.
  const trace = provider.createTrace({
    traceId: event.trace.traceId,
    name: event.trace.name,
    groupId: event.trace.groupId ?? undefined,
    ...(event.trace.metadata != null ? { metadata: event.trace.metadata } : {}),
    ...(event.trace.tracingApiKey != null ? { tracingApiKey: event.trace.tracingApiKey } : {}),
    started: true,
  });
  if (!event.forwardToOtel) markSuppressOtelBridge(trace);
  return trace.end();
}

async function dispatchSpanStarted(event: Extract<AgentTracingSinkEvent, { kind: 'span_started' }>): Promise<void> {
  const span = new Span<SpanData>(
    {
      traceId: event.span.traceId,
      spanId: event.span.spanId,
      parentId: event.span.parentId ?? undefined,
      data: event.span.spanData as SpanData,
      startedAt: event.span.startedAt,
      error: event.span.error ?? undefined,
      ...(event.span.tracingApiKey != null ? { tracingApiKey: event.span.tracingApiKey } : {}),
    },
    // dispatchSpanStart fans through MultiTracingProcessor; Span's #processor is unread on this path.
    null as unknown as TracingProcessor
  );
  if (!event.forwardToOtel) markSuppressOtelBridge(span);
  await dispatchSpanStart(span);
}

async function dispatchSpanComplete(event: Extract<AgentTracingSinkEvent, { kind: 'span_complete' }>): Promise<void> {
  const span = new Span<SpanData>(
    {
      traceId: event.span.traceId,
      spanId: event.span.spanId,
      parentId: event.span.parentId ?? undefined,
      data: event.span.spanData as SpanData,
      startedAt: event.span.startedAt,
      ...(event.span.endedAt != null ? { endedAt: event.span.endedAt } : {}),
      error: event.span.error ?? undefined,
      ...(event.span.tracingApiKey != null ? { tracingApiKey: event.span.tracingApiKey } : {}),
    },
    // dispatchSpanEnd fans through MultiTracingProcessor; Span's #processor is unread on this path.
    null as unknown as TracingProcessor
  );
  if (!event.forwardToOtel) markSuppressOtelBridge(span);
  await dispatchSpanEnd(span);
}

async function dispatchToHostProcessors(event: AgentTracingSinkEvent): Promise<void> {
  switch (event.kind) {
    case 'trace_start':
      await dispatchTraceStart(event);
      return;
    case 'trace_end':
      await dispatchTraceEnd(event);
      return;
    case 'span_started':
      await dispatchSpanStarted(event);
      return;
    case 'span_complete':
      await dispatchSpanComplete(event);
      return;
    default:
      event satisfies never;
  }
}

export function makeAgentTracingSink(): InjectedSink<AgentTracingSink> {
  return {
    dispatch: {
      fn: async (_info, event) => {
        try {
          await dispatchToHostProcessors(event);
        } catch (err) {
          console.warn('[temporal-openai-agents] sink dispatch threw:', err);
        }
      },
      callDuringReplay: true,
    },
  };
}
