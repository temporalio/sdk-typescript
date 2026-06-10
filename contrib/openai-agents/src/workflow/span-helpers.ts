import { getCurrentTrace, createCustomSpan } from '@openai/agents-core';
import type { Headers } from '@temporalio/workflow';
import { currentAgentsSpanHeader, injectAgentsTraceHeader, type AgentsSpanHeader } from '../common/headers';
import { MCP_SERVER_SESSION_SUFFIX } from '../common/mcp-types';
import { withScopedSpan } from '../common/trace-context';
import { getCurrentPluginConfig } from './plugin-config-store';

export function shouldAddTemporalSpans(): boolean {
  return getCurrentPluginConfig()?.addTemporalSpans === true;
}

// Activity types treated as fire-and-forget. Currently only the stateful
// MCP session Activity.
const FIRE_AND_FORGET_ACTIVITY_SUFFIXES = [MCP_SERVER_SESSION_SUFFIX];

export function isFireAndForgetActivity(activityType: string): boolean {
  return FIRE_AND_FORGET_ACTIVITY_SUFFIXES.some((s) => activityType.endsWith(s));
}

// `spanId` is required for read-only handlers — their PRNG consumption isn't
// persisted to history, so generated IDs can collide with body spans.
export function maybeTemporalSpan<T>(
  spanName: string,
  fn: () => T,
  data?: Record<string, unknown>,
  spanId?: string
): T {
  if (shouldAddTemporalSpans() && getCurrentTrace()) {
    const span = createCustomSpan({
      data: { name: spanName, data: data ?? {} },
      ...(spanId !== undefined ? { spanId } : {}),
    });
    return withScopedSpan(span, fn);
  }
  return fn();
}

// Header capture happens inside the span body so the propagated spanId is the
// temporal span's — the receiving side parents under it.
export async function withInjectedHeader<I extends { headers: Headers }, T>(
  input: I,
  next: (i: I) => Promise<T>,
  spanConfig?: { name: string; data?: Record<string, unknown> }
): Promise<T> {
  const doInject = (): Promise<T> => {
    const header = currentAgentsSpanHeader();
    const headers = injectAgentsTraceHeader(input.headers, header);
    return next({ ...input, headers });
  };

  if (spanConfig) {
    return maybeTemporalSpan(spanConfig.name, doInject, spanConfig.data);
  }
  return doInject();
}

// Captures the current agent-SDK span header. When `shouldAddTemporalSpans()`
// is on and a trace is live, opens an INSTANT custom span around the capture
// so the propagated spanId is that span's — used at fire-and-forget call
// sites where a lifetime span would swallow later Activities as descendants.
export function captureHeaderUnderMaybeInstantSpan(spanName: string, data: Record<string, unknown>): AgentsSpanHeader {
  if (shouldAddTemporalSpans() && getCurrentTrace()) {
    const span = createCustomSpan({ data: { name: spanName, data } });
    return withScopedSpan(span, () => currentAgentsSpanHeader());
  }
  return currentAgentsSpanHeader();
}
