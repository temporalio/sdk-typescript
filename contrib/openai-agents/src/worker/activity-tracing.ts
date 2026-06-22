import { addTraceProcessor } from '@openai/agents-core';
import type { Span as AgentSpan, SpanData, Trace as AgentTrace } from '@openai/agents-core';
import { BaseAgentTracingProcessor, type SpanEntry } from './base-tracing-processor';
import { isSuppressOtelBridge } from './agent-sink-bridge';

export class ActivityTracingProcessor extends BaseAgentTracingProcessor {
  private readonly spans = new Map<string, SpanEntry>();

  protected getEntry(id: string): SpanEntry | undefined {
    return this.spans.get(id);
  }

  protected setEntry(id: string, entry: SpanEntry): void {
    this.spans.set(id, entry);
  }

  protected deleteEntry(id: string): void {
    this.spans.delete(id);
  }

  protected allEntries(): Iterable<SpanEntry> {
    return this.spans.values();
  }

  protected clearAllEntries(): void {
    this.spans.clear();
  }

  override async onTraceStart(trace: AgentTrace): Promise<void> {
    if (isSuppressOtelBridge(trace)) return;
    await super.onTraceStart(trace);
  }

  override async onTraceEnd(trace: AgentTrace): Promise<void> {
    if (isSuppressOtelBridge(trace)) return;
    await super.onTraceEnd(trace);
  }

  override async onSpanStart(span: AgentSpan<SpanData>): Promise<void> {
    if (isSuppressOtelBridge(span)) return;
    await super.onSpanStart(span);
  }

  override async onSpanEnd(span: AgentSpan<SpanData>): Promise<void> {
    if (isSuppressOtelBridge(span)) return;
    await super.onSpanEnd(span);
  }
}

let activityProcessorRegistered = false;

export function ensureActivityTracingProcessorRegistered(): void {
  if (activityProcessorRegistered) return;
  activityProcessorRegistered = true;
  addTraceProcessor(new ActivityTracingProcessor());
}
