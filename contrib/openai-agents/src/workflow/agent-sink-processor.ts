import type { Span as AgentSpan, SpanData, Trace as AgentTrace, TracingProcessor } from '@openai/agents-core';
import { proxySinks, workflowInfo } from '@temporalio/workflow';
import type { AgentTracingSinks, SerializedAgentSpan, SerializedAgentTrace } from '../common/agent-sink-types';
import { getCurrentPluginConfig } from './plugin-config-store';

function isReplayingHistoryEvents(): boolean {
  return workflowInfo().unsafe.isReplayingHistoryEvents;
}

function agentTracingSink(): AgentTracingSinks['agentTracing'] {
  return proxySinks<AgentTracingSinks>().agentTracing;
}

function shouldForwardToOtel(): boolean {
  return getCurrentPluginConfig()?.useOtelInstrumentation === true;
}

function serializeTrace(trace: AgentTrace): SerializedAgentTrace {
  return {
    type: 'trace',
    traceId: trace.traceId,
    name: trace.name,
    groupId: trace.groupId,
    metadata: trace.metadata,
    tracingApiKey: trace.tracingApiKey,
  };
}

// `endedAt` is `null` for `span_started`; the dangling-span sweep overrides it
// when `span.endedAt` is unset.
function serializeSpan(span: AgentSpan<SpanData>, endedAt?: string | null): SerializedAgentSpan {
  return {
    type: 'trace.span',
    spanId: span.spanId,
    traceId: span.traceId,
    parentId: span.parentId,
    spanData: { ...span.spanData } as Record<string, unknown>,
    error: span.error,
    tracingApiKey: span.tracingApiKey,
    startedAt: span.startedAt!,
    endedAt: endedAt !== undefined ? endedAt : span.endedAt,
  };
}

// Per-Workflow open-span tracker. Upstream `Runner.run` skips `.end()` on the current agent span when a run terminates via `next_step_interruption`, so without an external sweep the host would never see `span_complete` for that span. Keyed by `workflowId/runId`: both components are needed because continueAsNew runs of the same Workflow don't share state, and `reuseV8Context` shares the V8 isolate across concurrent Workflows.
const openSpansByWorkflow = new Map<string, Map<string, AgentSpan<SpanData>>>();

function currentWorkflowKey(): string {
  const info = workflowInfo();
  return `${info.workflowId}/${info.runId}`;
}

function spansForCurrentWorkflow(): Map<string, AgentSpan<SpanData>> {
  const key = currentWorkflowKey();
  let inner = openSpansByWorkflow.get(key);
  if (!inner) {
    inner = new Map();
    openSpansByWorkflow.set(key, inner);
  }
  return inner;
}

/**
 * Sweeps spans the agent SDK never called `.end()` on — specifically the
 * current-agent span on the `next_step_interruption` interrupt path. Called
 * by the runner in its `finally` block after every `Runner.run` invocation
 * (the open-spans map is empty on success/throw, non-empty only on dangling-
 * span paths like interrupt). Also called by the inbound interceptor's
 * `finally` as a safety net for spans opened outside `runner.run`, e.g., a
 * bare `withTrace` in the Workflow body.
 */
export async function flushOpenSpans(): Promise<void> {
  const key = currentWorkflowKey();
  const inner = openSpansByWorkflow.get(key);
  if (!inner || inner.size === 0) {
    openSpansByWorkflow.delete(key);
    return;
  }
  if (!isReplayingHistoryEvents()) {
    const sink = agentTracingSink();
    const forward = shouldForwardToOtel();
    for (const span of inner.values()) {
      sink.dispatch({
        kind: 'span_complete',
        span: serializeSpan(span, new Date().toISOString()),
        forwardToOtel: forward,
      });
    }
  }
  openSpansByWorkflow.delete(key);
}

export function clearOpenSpans(): void {
  openSpansByWorkflow.delete(currentWorkflowKey());
}

export class WorkflowAgentSinkProcessor implements TracingProcessor {
  async onTraceStart(trace: AgentTrace): Promise<void> {
    if (isReplayingHistoryEvents()) return;
    agentTracingSink().dispatch({
      kind: 'trace_start',
      trace: serializeTrace(trace),
      forwardToOtel: shouldForwardToOtel(),
    });
  }

  async onTraceEnd(trace: AgentTrace): Promise<void> {
    if (isReplayingHistoryEvents()) return;
    agentTracingSink().dispatch({
      kind: 'trace_end',
      trace: serializeTrace(trace),
      forwardToOtel: shouldForwardToOtel(),
    });
  }

  async onSpanStart(span: AgentSpan<SpanData>): Promise<void> {
    spansForCurrentWorkflow().set(span.spanId, span);
    if (isReplayingHistoryEvents()) return;
    agentTracingSink().dispatch({
      kind: 'span_started',
      span: serializeSpan(span, null),
      forwardToOtel: shouldForwardToOtel(),
    });
  }

  async onSpanEnd(span: AgentSpan<SpanData>): Promise<void> {
    spansForCurrentWorkflow().delete(span.spanId);
    if (isReplayingHistoryEvents()) return;
    agentTracingSink().dispatch({
      kind: 'span_complete',
      span: serializeSpan(span),
      forwardToOtel: shouldForwardToOtel(),
    });
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
