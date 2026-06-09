import * as otel from '@opentelemetry/api';
import { getCurrentTraceContext } from '@openai/agents-core';
import { defaultPayloadConverter, type Headers } from '@temporalio/common';
import type { SerializableModelActivityOptions } from './model-activity-options';

export const AGENTS_TRACE_HEADER_KEY = '__openai_span';

export interface AgentsSpanHeader {
  traceName: string;
  spanId: string | null;
  traceId: string | null;
  otelSpanId?: string;
}

export function injectAgentsTraceHeader(headers: Headers, info: AgentsSpanHeader): Headers {
  return { ...headers, [AGENTS_TRACE_HEADER_KEY]: defaultPayloadConverter.toPayload(info) };
}

export function extractAgentsTraceHeader(headers: Headers): AgentsSpanHeader | null {
  const payload = headers[AGENTS_TRACE_HEADER_KEY];
  if (!payload) return null;
  return defaultPayloadConverter.fromPayload<AgentsSpanHeader>(payload);
}

export function injectAgentsTraceHeaderNexus(
  headers: Record<string, string>,
  info: AgentsSpanHeader
): Record<string, string> {
  return { ...headers, [AGENTS_TRACE_HEADER_KEY]: JSON.stringify(info) };
}

export function extractAgentsTraceHeaderNexus(headers: Record<string, string>): AgentsSpanHeader | null {
  const raw = headers[AGENTS_TRACE_HEADER_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentsSpanHeader;
  } catch {
    return null;
  }
}

export function currentAgentsSpanHeader(): AgentsSpanHeader {
  const ctx = getCurrentTraceContext();
  const otelSpanContext = otel.trace.getSpanContext(otel.context.active());
  return {
    traceName: ctx?.trace.name ?? 'Unknown Workflow',
    spanId: ctx?.span?.spanId ?? null,
    traceId: ctx?.trace.traceId ?? null,
    ...(otelSpanContext ? { otelSpanId: otelSpanContext.spanId } : {}),
  };
}

export const AGENTS_CONFIG_HEADER_KEY = '__openai_agents_config';

export interface AgentsConfigHeader {
  addTemporalSpans?: boolean;
  useOtelInstrumentation?: boolean;
  modelParams?: SerializableModelActivityOptions;
}

export function injectAgentsConfigHeader(headers: Headers, config: AgentsConfigHeader): Headers {
  return { ...headers, [AGENTS_CONFIG_HEADER_KEY]: defaultPayloadConverter.toPayload(config) };
}

export function extractAgentsConfigHeader(headers: Headers): AgentsConfigHeader | undefined {
  const payload = headers[AGENTS_CONFIG_HEADER_KEY];
  if (!payload) return undefined;
  return defaultPayloadConverter.fromPayload<AgentsConfigHeader>(payload);
}
