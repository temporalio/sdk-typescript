import type { Agent } from '@openai/agents-core';

/**
 * Centralizes all access to upstream's typed-but-opaque Agent generic fields.
 * Used by both convertAgent (tool validation + model conversion) and any future
 * code that needs to inspect agent internals without casting inline.
 */
export function getAgentInternals(agent: Agent<any, any>): {
  model?: unknown;
  handoffs?: unknown[];
  tools?: unknown[];
} {
  return agent as unknown as { model?: unknown; handoffs?: unknown[]; tools?: unknown[] };
}
