import * as otel from '@opentelemetry/api';
import { type TracingProcessor, type Span, type Trace, type SpanData } from '@openai/agents-core';
import {
  TRACER_NAME,
  spanNameFromData,
  staticAttributesFromSpanData,
  dynamicAttributesFromSpanData,
  agentTraceIdToOtelTraceId,
  agentSpanIdToOtelSpanId,
  agentTraceIdToOtelRootSpanId,
} from '../common/tracing-bridge';
import { withSeededIds } from './seeded-ids';

export interface SpanEntry {
  span: otel.Span;
  context: otel.Context;
}

function syntheticParentContext(otelTraceId: string, otelParentSpanId: string): otel.Context {
  const spanContext: otel.SpanContext = {
    traceId: otelTraceId,
    spanId: otelParentSpanId,
    traceFlags: otel.TraceFlags.SAMPLED,
    isRemote: true,
  };
  return otel.trace.setSpanContext(otel.ROOT_CONTEXT, spanContext);
}

export abstract class BaseAgentTracingProcessor implements TracingProcessor {
  // Re-resolved per access: tracers cache their source provider's processors, breaking across setGlobalTracerProvider() swaps.
  protected get tracer(): otel.Tracer {
    return otel.trace.getTracer(TRACER_NAME);
  }

  protected abstract getEntry(spanId: string): SpanEntry | undefined;
  protected abstract setEntry(spanId: string, entry: SpanEntry): void;
  protected abstract deleteEntry(spanId: string): void;
  protected abstract allEntries(): Iterable<SpanEntry>;

  async onTraceStart(trace: Trace): Promise<void> {
    const attrs: otel.Attributes = { 'openai.agents.trace_id': trace.traceId };
    if (trace.name) attrs['openai.agents.trace.name'] = trace.name;
    if (trace.groupId) attrs['openai.agents.trace.group_id'] = trace.groupId;

    const otelTraceId = agentTraceIdToOtelTraceId(trace.traceId);
    const rootOtelSpanId = agentTraceIdToOtelRootSpanId(trace.traceId);

    const span = withSeededIds(otelTraceId, rootOtelSpanId, () =>
      this.tracer.startSpan(trace.name || 'openai.agents.run', { attributes: attrs, root: true })
    );
    const ctx = otel.trace.setSpan(otel.ROOT_CONTEXT, span);
    this.setEntry(trace.traceId, { span, context: ctx });
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    const entry = this.getEntry(trace.traceId);
    if (!entry) return;
    entry.span.setStatus({ code: otel.SpanStatusCode.OK });
    entry.span.end();
    this.deleteEntry(trace.traceId);
  }

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    const data = span.spanData;
    const name = spanNameFromData(data);
    const attrs = staticAttributesFromSpanData(data);

    const otelSpanId = agentSpanIdToOtelSpanId(span.spanId);

    const parentEntry = span.parentId ? this.getEntry(span.parentId) : this.getEntry(span.traceId);
    let otelSpan: otel.Span;
    let ctx: otel.Context;
    if (parentEntry) {
      otelSpan = withSeededIds(undefined, otelSpanId, () =>
        this.tracer.startSpan(name, { attributes: attrs }, parentEntry.context)
      );
      ctx = otel.trace.setSpan(parentEntry.context, otelSpan);
    } else if (!span.parentId) {
      // Workflow-side spans arrive on end, so a child span may surface before its trace's
      // onTraceStart; synthesize the parent from the deterministic root-span ID.
      const parentCtx = syntheticParentContext(
        agentTraceIdToOtelTraceId(span.traceId),
        agentTraceIdToOtelRootSpanId(span.traceId)
      );
      otelSpan = withSeededIds(undefined, otelSpanId, () =>
        this.tracer.startSpan(name, { attributes: attrs }, parentCtx)
      );
      ctx = otel.trace.setSpan(parentCtx, otelSpan);
    } else {
      // Parent span still open Workflow-side (ships only when it ends); synthesize from the derived OTel ID.
      const parentCtx = syntheticParentContext(
        agentTraceIdToOtelTraceId(span.traceId),
        agentSpanIdToOtelSpanId(span.parentId)
      );
      otelSpan = withSeededIds(undefined, otelSpanId, () =>
        this.tracer.startSpan(name, { attributes: attrs }, parentCtx)
      );
      ctx = otel.trace.setSpan(parentCtx, otelSpan);
    }
    this.setEntry(span.spanId, { span: otelSpan, context: ctx });
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    const entry = this.getEntry(span.spanId);
    if (!entry) return;

    // Some span types (notably `handoff`) populate fields after start(),
    // so re-derive the name at end to capture the final state.
    entry.span.updateName(spanNameFromData(span.spanData));

    const dynAttrs = dynamicAttributesFromSpanData(span.spanData);
    for (const [key, value] of Object.entries(dynAttrs)) {
      if (value !== undefined) entry.span.setAttribute(key, value);
    }

    if (span.error) {
      entry.span.setStatus({ code: otel.SpanStatusCode.ERROR, message: span.error.message });
      entry.span.recordException(new Error(span.error.message));
    } else {
      entry.span.setStatus({ code: otel.SpanStatusCode.OK });
    }

    entry.span.end();
    this.deleteEntry(span.spanId);
  }

  async shutdown(): Promise<void> {
    for (const entry of this.allEntries()) {
      entry.span.end();
    }
    this.clearAllEntries();
  }

  protected abstract clearAllEntries(): void;

  async forceFlush(): Promise<void> {}
}
