import type { Agent, AgentInputItem } from '@openai/agents-core';
import type { ActivityCancellationType, Duration, Priority, RetryPolicy } from '@temporalio/common';

export type { AgentInputItem } from '@openai/agents-core';

export interface ModelSummaryProvider {
  provide(
    agent: Agent<any, any> | undefined,
    instructions: string | undefined,
    input: string | AgentInputItem[]
  ): string;
}

export interface ModelActivityOptions {
  taskQueue?: string;
  scheduleToCloseTimeout?: Duration;
  scheduleToStartTimeout?: Duration;
  startToCloseTimeout?: Duration;
  heartbeatTimeout?: Duration;
  retryPolicy?: RetryPolicy;
  useLocalActivity?: boolean;
  summaryOverride?: string | ModelSummaryProvider;
  cancellationType?: ActivityCancellationType;
  priority?: Priority;
}

export const DEFAULT_MODEL_ACTIVITY_OPTIONS: ModelActivityOptions = {
  startToCloseTimeout: '60s',
  useLocalActivity: false,
};
