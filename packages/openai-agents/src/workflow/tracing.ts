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

export function getWorkflowTracingConfig(): 'disabled' | 'enabled' {
  return 'enabled';
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

/**
 * Bridges OpenAI Agents SDK trace events to OpenTelemetry spans.
 *
 * Requires @temporalio/interceptors-opentelemetry (or equivalent) to set up an OTel
 * tracer provider in the workflow sandbox. Without a registered provider,
 * otel.trace.getTracer() returns a no-op tracer and spans are silently discarded.
 *
 * Activity spans from interceptors-opentelemetry appear as siblings of generation
 * spans, not children. Proper nesting would require pushing OTel context before the
 * activity call — deferred to a follow-up.
 */
export class TemporalTracingProcessor implements TracingProcessor {
  private readonly tracer: otel.Tracer;
  private readonly spans = new Map<string, SpanEntry>();

  constructor() {
    this.tracer = otel.trace.getTracer(TRACER_NAME);
  }

  async onTraceStart(trace: Trace): Promise<void> {
    if (isReplaying()) return;

    const parentCtx = otel.context.active();
    const attrs: otel.Attributes = { 'openai.agents.trace_id': trace.traceId };
    if (trace.name) attrs['openai.agents.trace.name'] = trace.name;
    if (trace.groupId) attrs['openai.agents.trace.group_id'] = trace.groupId;

    const span = this.tracer.startSpan('openai.agents.run', { attributes: attrs }, parentCtx);
    const ctx = otel.trace.setSpan(parentCtx, span);
    this.spans.set(trace.traceId, { span, context: ctx });
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    const entry = this.spans.get(trace.traceId);
    if (!entry) return;
    entry.span.setStatus({ code: otel.SpanStatusCode.OK });
    entry.span.end();
    this.spans.delete(trace.traceId);
  }

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    if (isReplaying()) return;

    const data = span.spanData;
    const name = spanNameFromData(data);
    const attrs = staticAttributesFromSpanData(data);

    let parentCtx: otel.Context;
    const parentEntry = span.parentId ? this.spans.get(span.parentId) : this.spans.get(span.traceId);
    if (parentEntry) {
      parentCtx = parentEntry.context;
    } else {
      parentCtx = otel.context.active();
    }

    const otelSpan = this.tracer.startSpan(name, { attributes: attrs }, parentCtx);
    const ctx = otel.trace.setSpan(parentCtx, otelSpan);
    this.spans.set(span.spanId, { span: otelSpan, context: ctx });
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    const entry = this.spans.get(span.spanId);
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
    this.spans.delete(span.spanId);
  }

  async shutdown(): Promise<void> {
    for (const [, entry] of this.spans) {
      entry.span.end();
    }
    this.spans.clear();
  }

  async forceFlush(): Promise<void> {
    // No buffering — spans are forwarded to OTel immediately
  }
}

/**
 * Appends a {@link TemporalTracingProcessor} to the OpenAI Agents SDK's
 * processor list and enables tracing (overrides the upstream default that
 * disables tracing when `NODE_ENV=test` or in browser-like environments).
 *
 * Uses `addTraceProcessor` rather than `setTraceProcessors` so that any
 * processors registered by user code before runner construction are preserved.
 * The upstream `TraceProvider` starts with an empty processor list — no default
 * exporter is auto-registered — so there is no network-I/O risk from keeping
 * pre-existing processors.
 *
 * Idempotent — safe to call multiple times per isolate.
 */
export function ensureTracingProcessorRegistered(): void {
  if ((globalThis as any)[REGISTERED_KEY]) return;
  (globalThis as any)[REGISTERED_KEY] = true;
  setTracingDisabled(false);
  addTraceProcessor(new TemporalTracingProcessor());
}
