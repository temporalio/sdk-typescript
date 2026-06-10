import type { Agent, AgentInputItem } from '@openai/agents-core';
import type { ActivityOptions } from '@temporalio/common';

export interface ModelSummaryProvider {
  /**
   * Generate a human-readable summary for the model Activity shown in the Temporal UI.
   * Runs inside the Workflow sandbox, so it must be deterministic and perform no non-deterministic I/O.
   */
  provide(
    agent: Agent<any, any> | undefined,
    instructions: string | undefined,
    input: string | AgentInputItem[]
  ): string;
}

export interface ModelActivityOptions extends Omit<ActivityOptions, 'summary'> {
  /** Use local Activities instead of regular Activities. @default false */
  useLocalActivity?: boolean;
  /** Activity summary shown in the Temporal UI. String for static text, ModelSummaryProvider for dynamic. */
  summary?: string | ModelSummaryProvider;
}

/**
 * Plugin-side model Activity options propagated to Workflows via the
 * `__openai_agents_config` header. The function form of `summary`
 * is excluded because functions cannot survive JSON serialization.
 */
export type SerializableModelActivityOptions = Omit<ModelActivityOptions, 'summary'> & {
  /** Static summary string used as a tracing summary override. */
  summary?: string;
};

export const DEFAULT_MODEL_ACTIVITY_OPTIONS: SerializableModelActivityOptions = {
  startToCloseTimeout: '60s',
  useLocalActivity: false,
};
