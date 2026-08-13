import type { ModelResponse, StreamEvent } from '@openai/agents-core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns `raw` without its `tools` key, by identity when there is nothing to drop. */
function withoutTools(raw: unknown): unknown {
  if (!isRecord(raw) || !('tools' in raw)) return raw;
  const { tools: _tools, ...rest } = raw;
  return rest;
}

/** Rebuilds `container` only when `update` actually changed the value at `key`. */
function replaceIn<T>(container: T, key: string, update: (value: unknown) => unknown): T {
  if (!isRecord(container)) return container;
  const current = container[key];
  const next = update(current);
  return next === current ? container : ({ ...container, [key]: next } as T);
}

/** Drops the echoed request tools, which carry resolved credentials, from the raw `Response`. */
export function stripEchoedTools(providerData: ModelResponse['providerData']): ModelResponse['providerData'] {
  // The OpenAI Responses model sets `providerData` to the raw `Response`.
  return withoutTools(providerData) as ModelResponse['providerData'];
}

/** Paths are explicit, not searched: a recursive hunt would also strip an `mcp_list_tools` item's advertised list. */
export function stripEchoedToolsFromStreamEvent(event: StreamEvent): StreamEvent {
  switch (event.type) {
    case 'response_started':
      // `providerData` is the raw `response.created` event.
      return replaceIn(event, 'providerData', (data) => replaceIn(data, 'response', withoutTools));
    case 'response_done':
      // `response.providerData` is the raw `Response` minus `output`/`usage`/`id`.
      return replaceIn(event, 'response', (response) => replaceIn(response, 'providerData', withoutTools));
    case 'model':
      // `event` is the raw SSE event; only some of them carry a `response`.
      return replaceIn(event, 'event', (raw) => replaceIn(raw, 'response', withoutTools));
    default:
      return event;
  }
}
