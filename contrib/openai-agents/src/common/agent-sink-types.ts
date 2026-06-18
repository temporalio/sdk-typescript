import type { Sink, Sinks } from '@temporalio/workflow';

export interface SerializedAgentTrace {
  type: 'trace';
  traceId: string;
  name: string;
  groupId: string | null;
  metadata?: Record<string, unknown>;
  tracingApiKey?: string;
}

export interface SerializedAgentSpan {
  type: 'trace.span';
  spanId: string;
  traceId: string;
  parentId: string | null;
  spanData: Record<string, unknown>;
  error: { message: string; data?: Record<string, unknown> } | null;
  tracingApiKey?: string;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentTracingSink extends Sink {
  dispatch(event: AgentTracingSinkEvent): void;
}

export type AgentTracingSinkEvent =
  | { kind: 'trace_start'; trace: SerializedAgentTrace; forwardToOtel: boolean }
  | { kind: 'trace_end'; trace: SerializedAgentTrace; forwardToOtel: boolean }
  | { kind: 'span_started'; span: SerializedAgentSpan; forwardToOtel: boolean }
  | { kind: 'span_complete'; span: SerializedAgentSpan; forwardToOtel: boolean };

export const AGENT_TRACING_SINK_NAME = '__temporal_openaiAgentsTracing' as const;

export interface AgentTracingSinks extends Sinks {
  [AGENT_TRACING_SINK_NAME]: AgentTracingSink;
}
