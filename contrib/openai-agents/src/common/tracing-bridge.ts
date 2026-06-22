import type * as otel from '@opentelemetry/api';
import type { SpanData } from '@openai/agents-core';

export const TRACER_NAME = '@temporalio/openai-agents';

export const TEMPORAL_REPLAY_SAFE_BRAND = '_temporalReplaySafeTracerProvider';

export function markReplaySafeTracerProvider<T extends object>(provider: T): T {
  Object.defineProperty(provider, TEMPORAL_REPLAY_SAFE_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return provider;
}

export function isReplaySafeTracerProvider(provider: unknown): boolean {
  return (
    provider !== null &&
    (typeof provider === 'object' || typeof provider === 'function') &&
    (provider as Record<string, unknown>)[TEMPORAL_REPLAY_SAFE_BRAND] === true
  );
}

export function agentTraceIdToOtelTraceId(agentTraceId: string): string {
  const hex = agentTraceId.startsWith('trace_') ? agentTraceId.slice(6) : agentTraceId.replace(/-/g, '');
  return hex.padStart(32, '0').slice(0, 32).toLowerCase();
}

export function agentSpanIdToOtelSpanId(agentSpanId: string): string {
  const hex = agentSpanId.startsWith('span_') ? agentSpanId.slice(5) : agentSpanId.replace(/-/g, '');
  return hex.padStart(16, '0').slice(0, 16).toLowerCase();
}

/** OTel span ID for a trace's root span, derived deterministically from the agent-SDK trace ID so host and Workflow sides agree without explicit propagation. */
export function agentTraceIdToOtelRootSpanId(agentTraceId: string): string {
  return agentTraceIdToOtelTraceId(agentTraceId).slice(0, 16);
}

export function spanNameFromData(data: SpanData): string {
  switch (data.type) {
    case 'agent':
      return `agent:${data.name}`;
    case 'function':
      return `function:${data.name}`;
    case 'generation':
      return 'generation';
    case 'response':
      return 'response';
    case 'handoff':
      return `handoff:${data.from_agent ?? 'unknown'}->${data.to_agent ?? 'unknown'}`;
    case 'guardrail':
      return `guardrail:${data.name}`;
    case 'custom':
      return data.name;
    case 'transcription':
      return 'transcription';
    case 'speech':
      return 'speech';
    case 'speech_group':
      return 'speech_group';
    case 'mcp_tools':
      return 'mcp_tools';
    default:
      return 'unknown';
  }
}

export function staticAttributesFromSpanData(data: SpanData): otel.Attributes {
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
    case 'guardrail':
      attrs['openai.agents.guardrail.name'] = data.name;
      break;
    case 'custom':
      attrs['openai.agents.custom.name'] = data.name;
      // Surface top-level `data.data` keys (e.g. `signalName`, `activityType`)
      // as OTel attributes for trace-UI filtering.
      if (data.data && typeof data.data === 'object') {
        for (const [key, value] of Object.entries(data.data as Record<string, unknown>)) {
          const coerced = coerceToOtelAttribute(value);
          if (coerced !== undefined) attrs[`openai.agents.custom.data.${key}`] = coerced;
        }
      }
      break;
    case 'mcp_tools':
      if (data.server) attrs['openai.agents.mcp_tools.server'] = data.server;
      break;
  }
  return attrs;
}

// OTel attributes accept strings, numbers, booleans, or homogeneous arrays;
// anything else returns undefined.
function coerceToOtelAttribute(value: unknown): otel.AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [] as string[];
    const elemType = typeof value[0];
    if (elemType !== 'string' && elemType !== 'number' && elemType !== 'boolean') return undefined;
    for (const elem of value) {
      if (typeof elem !== elemType) return undefined;
    }
    return value as otel.AttributeValue;
  }
  return undefined;
}

export function dynamicAttributesFromSpanData(data: SpanData): otel.Attributes {
  const attrs: otel.Attributes = {};
  switch (data.type) {
    case 'agent':
      if (data.tools) attrs['openai.agents.agent.tools'] = data.tools.join(',');
      break;
    case 'generation':
      if (data.model) attrs['openai.agents.generation.model'] = data.model;
      break;
    case 'handoff':
      if (data.from_agent) attrs['openai.agents.handoff.from_agent'] = data.from_agent;
      if (data.to_agent) attrs['openai.agents.handoff.to_agent'] = data.to_agent;
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
