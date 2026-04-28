import * as otel from '@opentelemetry/api';
import {
  type TracingProcessor,
  type Span,
  type Trace,
  type SpanData,
  addTraceProcessor,
  setTracingDisabled,
} from '@openai/agents-core';
import { inWorkflowContext, workflowInfo } from '@temporalio/workflow';

// --- Existing public helpers (preserved) ---

export function isInWorkflow(): boolean {
  return inWorkflowContext();
}

export function isReplaying(): boolean {
  if (!inWorkflowContext()) return false;
  return workflowInfo().unsafe.isReplaying;
}

// --- OTel bridge: maps OpenAI Agents SDK trace events to OTel spans ---

const TRACER_NAME = '@temporalio/openai-agents';
const REGISTERED_KEY = Symbol.for('temporal-openai-agents-processor-registered');

function spanNameFromData(data: SpanData): string {
  switch (data.type) {
    case 'agent':
      return `openai.agents.agent:${data.name}`;
    case 'function':
      return `openai.agents.function:${data.name}`;
    case 'generation':
      return 'openai.agents.generation';
    case 'response':
      return 'openai.agents.response';
    case 'handoff':
      return 'openai.agents.handoff';
    case 'guardrail':
      return `openai.agents.guardrail:${data.name}`;
    case 'custom':
      return `openai.agents.custom:${data.name}`;
    case 'transcription':
      return 'openai.agents.transcription';
    case 'speech':
      return 'openai.agents.speech';
    case 'speech_group':
      return 'openai.agents.speech_group';
    case 'mcp_tools':
      return 'openai.agents.mcp_tools';
    default:
      return 'openai.agents.unknown';
  }
}

function staticAttributesFromSpanData(data: SpanData): otel.Attributes {
  const attrs: otel.Attributes = { 'openai.agents.span_type': data.type };
  switch (data.type) {
    case 'agent':
      attrs['openai.agents.agent.name'] = data.name;
      if (data.handoffs) attrs['openai.agents.agent.handoffs'] = data.handoffs.join(',');
      if (data.output_type) attrs['openai.agents.agent.output_type'] = data.output_type;
      break;
    case 'function':
      attrs['openai.agents.function.name'] = data.name;
      break;
    case 'handoff':
      if (data.from_agent) attrs['openai.agents.handoff.from_agent'] = data.from_agent;
      if (data.to_agent) attrs['openai.agents.handoff.to_agent'] = data.to_agent;
      break;
    case 'guardrail':
      attrs['openai.agents.guardrail.name'] = data.name;
      break;
    case 'custom':
      attrs['openai.agents.custom.name'] = data.name;
      break;
    case 'mcp_tools':
      if (data.server) attrs['openai.agents.mcp_tools.server'] = data.server;
      break;
  }
  return attrs;
}

function dynamicAttributesFromSpanData(data: SpanData): otel.Attributes {
  const attrs: otel.Attributes = {};
  switch (data.type) {
    case 'agent':
      if (data.tools) attrs['openai.agents.agent.tools'] = data.tools.join(',');
      break;
    case 'generation':
      if (data.model) attrs['openai.agents.generation.model'] = data.model;
      break;
    case 'guardrail':
      attrs['openai.agents.guardrail.triggered'] = data.triggered;
      break;
    case 'mcp_tools':
      if (data.result) attrs['openai.agents.mcp_tools.result'] = data.result.join(',');
      break;
  }
  return attrs;
}

interface SpanEntry {
  span: otel.Span;
  context: otel.Context;
}

export interface TemporalTracingProcessorOptions {
  /**
   * When `true`, emit OTel spans even during workflow replay. Defaults to `false`.
   * Useful for debugging replay-divergence issues where trace output helps identify
   * which spans differ between original execution and replay.
   */
  startSpansInReplay?: boolean;
}

/**
 * Bridges OpenAI Agents SDK trace events to OpenTelemetry spans.
 *
 * Requires @temporalio/interceptors-opentelemetry (or equivalent) to set up an OTel
 * tracer provider in the workflow sandbox. Without a registered provider,
 * otel.trace.getTracer() returns a no-op tracer and spans are silently discarded.
 *
 * Deterministic trace/span IDs are provided by the `crypto.randomUUID` polyfill in
 * `load-polyfills.ts`, which delegates to Temporal's `uuid4()` (per-workflow seeded
 * PRNG). Upstream `@openai/agents-core` calls `crypto.randomUUID()` internally for
 * ID generation, so IDs are automatically replay-safe without a custom TraceProvider.
 *
 * Activity spans nest correctly under generation spans when
 * `@temporalio/interceptors-opentelemetry` is configured (recommended). The OTel
 * outbound interceptor injects the active span context into activity headers, and the
 * inbound interceptor extracts it so the activity span becomes a child of the
 * generation span. Without `interceptors-opentelemetry`, activity spans appear at
 * the workflow level rather than nested.
 */
export class TemporalTracingProcessor implements TracingProcessor {
  private readonly tracer: otel.Tracer;
  private readonly startSpansInReplay: boolean;
  // Outer key: workflowId, inner key: spanId or traceId.
  // Scoped per-workflow so concurrent workflows on the same worker don't share state.
  private readonly spans = new Map<string, Map<string, SpanEntry>>();

  constructor(options?: TemporalTracingProcessorOptions) {
    this.tracer = otel.trace.getTracer(TRACER_NAME);
    this.startSpansInReplay = options?.startSpansInReplay ?? false;
  }

  private getWorkflowSpans(): Map<string, SpanEntry> {
    const wfId = workflowInfo().workflowId;
    let inner = this.spans.get(wfId);
    if (!inner) {
      inner = new Map();
      this.spans.set(wfId, inner);
    }
    return inner;
  }

  private getSpanEntry(id: string): SpanEntry | undefined {
    return this.spans.get(workflowInfo().workflowId)?.get(id);
  }

  private deleteSpanEntry(id: string): void {
    const wfId = workflowInfo().workflowId;
    const inner = this.spans.get(wfId);
    if (!inner) return;
    inner.delete(id);
    if (inner.size === 0) this.spans.delete(wfId);
  }

  private shouldSkip(): boolean {
    return !this.startSpansInReplay && isReplaying();
  }

  async onTraceStart(trace: Trace): Promise<void> {
    if (this.shouldSkip()) return;

    const parentCtx = otel.context.active();
    const attrs: otel.Attributes = { 'openai.agents.trace_id': trace.traceId };
    if (trace.name) attrs['openai.agents.trace.name'] = trace.name;
    if (trace.groupId) attrs['openai.agents.trace.group_id'] = trace.groupId;

    const span = this.tracer.startSpan('openai.agents.run', { attributes: attrs }, parentCtx);
    const ctx = otel.trace.setSpan(parentCtx, span);
    this.getWorkflowSpans().set(trace.traceId, { span, context: ctx });
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    if (this.shouldSkip()) return;

    const entry = this.getSpanEntry(trace.traceId);
    if (!entry) return;
    entry.span.setStatus({ code: otel.SpanStatusCode.OK });
    entry.span.end();
    this.deleteSpanEntry(trace.traceId);
  }

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    if (this.shouldSkip()) return;

    const data = span.spanData;
    const name = spanNameFromData(data);
    const attrs = staticAttributesFromSpanData(data);

    let parentCtx: otel.Context;
    const parentEntry = span.parentId ? this.getSpanEntry(span.parentId) : this.getSpanEntry(span.traceId);
    if (parentEntry) {
      parentCtx = parentEntry.context;
    } else {
      parentCtx = otel.context.active();
    }

    const otelSpan = this.tracer.startSpan(name, { attributes: attrs }, parentCtx);
    const ctx = otel.trace.setSpan(parentCtx, otelSpan);
    this.getWorkflowSpans().set(span.spanId, { span: otelSpan, context: ctx });
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    if (this.shouldSkip()) return;

    const entry = this.getSpanEntry(span.spanId);
    if (!entry) return;

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
    this.deleteSpanEntry(span.spanId);
  }

  async shutdown(): Promise<void> {
    for (const [, inner] of this.spans) {
      for (const [, entry] of inner) {
        entry.span.end();
      }
    }
    this.spans.clear();
  }

  async forceFlush(): Promise<void> {
    // No buffering — spans are forwarded to OTel immediately
  }
}

/**
 * Appends a {@link TemporalTracingProcessor} to the OpenAI Agents SDK's
 * global processor list and enables tracing.
 *
 * **Side effect**: mutates the upstream `@openai/agents-core` global
 * `TraceProvider` (stored on `globalThis` via a well-known Symbol). A single
 * {@link TemporalTracingProcessor} instance is shared across all workflows in
 * the V8 isolate; per-workflow isolation is handled internally by the processor's
 * workflow-scoped span Map.
 *
 * Called automatically by the {@link TemporalOpenAIRunner} constructor — users
 * do not need to call this unless they need tracing without a runner instance.
 *
 * Uses `addTraceProcessor` rather than `setTraceProcessors` so that any
 * processors registered by user code before runner construction are preserved.
 * The upstream `TraceProvider` starts with an empty processor list — no default
 * exporter is auto-registered — so there is no network-I/O risk from keeping
 * pre-existing processors.
 *
 * Idempotent — safe to call multiple times per isolate. Options from the first
 * call win; subsequent calls are no-ops regardless of options passed.
 */
export function ensureTracingProcessorRegistered(options?: TemporalTracingProcessorOptions): void {
  if ((globalThis as any)[REGISTERED_KEY]) return;
  (globalThis as any)[REGISTERED_KEY] = true;
  setTracingDisabled(false);
  addTraceProcessor(new TemporalTracingProcessor(options));
}
