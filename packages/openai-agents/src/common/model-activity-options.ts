import type { Agent, AgentInputItem } from '@openai/agents-core';
import { ActivityCancellationType, type Duration, type Priority, type RetryPolicy } from '@temporalio/common';

export type { AgentInputItem } from '@openai/agents-core';

export interface ModelSummaryProvider {
  /** Generate a human-readable summary for the model activity shown in the Temporal UI. */
  provide(
    agent: Agent<any, any> | undefined,
    instructions: string | undefined,
    input: string | AgentInputItem[]
  ): string;
}

export interface ModelActivityOptions {
  /** Task queue for the model activity. Defaults to the current worker's task queue. */
  taskQueue?: string;
  /** Maximum total time from schedule to completion, including retries. */
  scheduleToCloseTimeout?: Duration;
  /** Maximum time the activity can wait in the task queue before a worker picks it up. */
  scheduleToStartTimeout?: Duration;
  /** Maximum time for a single activity execution attempt. @default '60s' */
  startToCloseTimeout?: Duration;
  /** Interval for heartbeat checks. The activity must heartbeat within this period. */
  heartbeatTimeout?: Duration;
  /** Retry policy for the model activity. Defaults to the server-defined policy. */
  retryPolicy?: RetryPolicy;
  /** Use local activities instead of regular activities. Avoids a server round-trip but lacks independent retry. @default false */
  useLocalActivity?: boolean;
  /** Activity summary shown in the Temporal UI. String for static text, ModelSummaryProvider for dynamic. */
  summaryOverride?: string | ModelSummaryProvider;
  /** How cancellation propagates from the workflow to the activity. @default ActivityCancellationType.TRY_CANCEL */
  cancellationType?: ActivityCancellationType;
  /** Priority for the model activity. Omit to use server defaults. */
  priority?: Priority;
}

export const DEFAULT_MODEL_ACTIVITY_OPTIONS: ModelActivityOptions = {
  startToCloseTimeout: '60s',
  useLocalActivity: false,
  cancellationType: ActivityCancellationType.TRY_CANCEL,
};
