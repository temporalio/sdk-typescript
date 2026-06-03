/**
 * Cross-boundary trace-context propagation for the LangSmith Temporal plugin.
 *
 * The LangSmith run context travels across every Temporal boundary
 * (client→workflow, workflow→activity, workflow→child-workflow,
 * workflow→Nexus, continue-as-new) as a single Temporal {@link Header}
 * entry. The wire value is exactly the object produced by
 * `RunTree.toHeaders()` — `{ "langsmith-trace": <dottedOrder>, baggage: <string> }`
 * — which the receiving side feeds straight back into
 * `RunTree.fromHeaders(...)` to reconstruct the parent run.
 *
 * Two encodings are supported because Temporal exposes two header shapes:
 *  - The binary/Temporal path (`Headers = Record<string, Payload>`): the
 *    context is encoded with the default payload converter.
 *  - The Nexus path (`Record<string, string>`): Nexus headers are plain
 *    strings with no Payload encoding, so the context is JSON-serialized.
 *
 * @module
 */

import { defaultPayloadConverter, type Payload } from '@temporalio/common';

/**
 * Temporal header key under which the LangSmith trace context is carried.
 *
 * Must byte-match the Python plugin's key so trace context propagates across SDKs.
 */
export const HEADER_KEY = '_temporal-langsmith-context';

/**
 * The serialized LangSmith trace context that crosses a Temporal boundary.
 *
 * This is structurally the output of `RunTree.toHeaders()`. Keeping it as a
 * plain JSON object lets the same value ride either the Payload transport or
 * the Nexus plain-string transport unchanged.
 */
export interface LangSmithTraceContext {
  /** The parent run's dotted order — the LangSmith trace pointer. */
  'langsmith-trace': string;
  /** LangSmith baggage (metadata / tags / project), comma-encoded. */
  baggage: string;
}

/** Case-insensitive key prefixes scrubbed from runs and propagated headers. */
const SENSITIVE_KEY_PREFIXES: readonly string[] = [
  'auth',
  'api_key',
  'api-key',
  'x-api-key',
  'apikey',
  'cookie',
  'set-cookie',
  'bearer',
  'secret',
  'token',
  'password',
];

/** Returns true when `key` looks like a credential-bearing header/metadata key. */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Return a shallow copy of `record` with all credential-bearing keys removed. */
export function scrubSensitive<T = unknown>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (record == null) {
    return record;
  }
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isSensitiveKey(key)) {
      out[key] = value;
    }
  }
  return out;
}

/** Encode a trace context into a Temporal `Payload` for the binary header transport. */
function encodeContextPayload(context: LangSmithTraceContext): Payload {
  return defaultPayloadConverter.toPayload(context);
}

/** Decode a trace context from a Temporal `Payload`; never throws (malformed → undefined). */
function decodeContextPayload(payload: Payload | undefined): LangSmithTraceContext | undefined {
  if (payload == null) {
    return undefined;
  }
  try {
    const value = defaultPayloadConverter.fromPayload<LangSmithTraceContext>(payload);
    return isTraceContext(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Encode a trace context as a plain string for the Nexus header transport. */
export function encodeContextString(context: LangSmithTraceContext): string {
  return JSON.stringify(context);
}

/** Decode a trace context from a Nexus plain-string header; never throws. */
export function decodeContextString(value: string | undefined): LangSmithTraceContext | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isTraceContext(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isTraceContext(value: unknown): value is LangSmithTraceContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['langsmith-trace'] === 'string'
  );
}

/**
 * Inject a trace context into a Payload-keyed Temporal header map, returning a
 * new map (interceptor inputs treat `headers` as immutable). Returns the input
 * unchanged when `context` is `undefined`.
 */
export function withContextHeader(
  headers: Record<string, Payload>,
  context: LangSmithTraceContext | undefined
): Record<string, Payload> {
  if (context === undefined) {
    return headers;
  }
  return { ...headers, [HEADER_KEY]: encodeContextPayload(context) };
}

export function readContextHeader(headers: Record<string, Payload> | undefined): LangSmithTraceContext | undefined {
  return decodeContextPayload(headers?.[HEADER_KEY]);
}

/**
 * Temporal-internal query names that must NOT produce a LangSmith run.
 *
 * Mirrors the Python plugin: any `__temporal`-prefixed query plus the
 * stack-trace introspection queries are filtered out of tracing.
 */
export function isInternalQuery(queryName: string): boolean {
  return queryName.startsWith('__temporal') || queryName === '__stack_trace' || queryName === '__enhanced_stack_trace';
}
