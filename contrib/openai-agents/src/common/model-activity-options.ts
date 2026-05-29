import type { Agent, AgentInputItem } from '@openai/agents-core';
import { ActivityCancellationType, type Duration, type Priority, type RetryPolicy } from '@temporalio/common';

export interface ModelSummaryProvider {
  /** Generate a human-readable summary for the model Activity shown in the Temporal UI. */
  provide(
    agent: Agent<any, any> | undefined,
    instructions: string | undefined,
    input: string | AgentInputItem[]
  ): string;
}

export interface ModelActivityOptions {
  /** Task Queue for the model Activity. Defaults to the current Worker's Task Queue. */
  taskQueue?: string;
  /** Maximum total time from schedule to completion, including retries. */
  scheduleToCloseTimeout?: Duration;
  /** Maximum time the Activity can wait in the Task Queue before a Worker picks it up. */
  scheduleToStartTimeout?: Duration;
  /** Maximum time for a single Activity execution attempt. @default '60s' */
  startToCloseTimeout?: Duration;
  /** Interval for heartbeat checks. The Activity must heartbeat within this period. */
  heartbeatTimeout?: Duration;
  /** Retry policy for the model Activity. Defaults to the server-defined policy. */
  retryPolicy?: RetryPolicy;
  /** Use local Activities instead of regular Activities. Avoids a server round-trip but lacks independent retry. @default false */
  useLocalActivity?: boolean;
  /** Activity summary shown in the Temporal UI. String for static text, ModelSummaryProvider for dynamic. */
  summaryOverride?: string | ModelSummaryProvider;
  /** How cancellation propagates from the Workflow to the Activity. @default ActivityCancellationType.TRY_CANCEL */
  cancellationType?: ActivityCancellationType;
  /** Priority for the model Activity. Omit to use server defaults. */
  priority?: Priority;
}

/**
 * Plugin-side model Activity options propagated to Workflows via the
 * `__openai_agents_config` header. The function form of `summaryOverride`
 * is excluded because functions cannot survive JSON serialization.
 */
export type SerializableModelActivityOptions = Omit<ModelActivityOptions, 'summaryOverride'> & {
  /** Static summary string used as a tracing summary override. */
  summaryOverride?: string;
};

export const DEFAULT_MODEL_ACTIVITY_OPTIONS: SerializableModelActivityOptions = {
  startToCloseTimeout: '60s',
  useLocalActivity: false,
  cancellationType: ActivityCancellationType.TRY_CANCEL,
};
