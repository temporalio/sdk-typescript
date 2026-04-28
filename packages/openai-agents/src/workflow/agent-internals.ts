import type { Agent } from '@openai/agents-core';

/**
 * Centralizes the most common access pattern for upstream's typed-but-opaque
 * Agent generic. Additional raw casts exist in runner.ts (to be migrated in
 * the runner.ts hardening batch).
 */
export function getAgentInternals(agent: Agent<any, any>): {
  model?: unknown;
  handoffs?: unknown[];
  tools?: unknown[];
} {
  return agent as unknown as { model?: unknown; handoffs?: unknown[]; tools?: unknown[] };
}
