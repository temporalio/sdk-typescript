import type { Agent, AgentInputItem } from '@openai/agents-core';
import type { ActivityOptions, Duration } from '@temporalio/common';

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
  /**
   * Topic that the streaming model Activity publishes raw model stream events to
   * for live external consumption. Required when running with `{ stream: true }`;
   * `run()` throws before scheduling any Activity if it is unset. The Workflow must
   * host a `WorkflowStream` (from `@temporalio/workflow-streams/workflow`) to receive
   * the publishes.
   *
   * @experimental Streaming support is experimental and may change without notice.
   */
  streamingTopic?: string;
  /**
   * Batch flush interval for the stream publisher used by the streaming Activity.
   *
   * @experimental Streaming support is experimental and may change without notice.
   */
  streamingBatchInterval?: Duration;
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

export const STREAMING_TOPIC_NOT_CONFIGURED = {
  type: 'StreamingTopicNotConfigured',
  message:
    "Streaming requires a streamingTopic. Set it via the plugin's modelParams on the client, " +
    "or via the runner's defaultModelParams (new TemporalOpenAIRunner({ defaultModelParams: { streamingTopic } })). " +
    'Host a WorkflowStream in your Workflow to use run(agent, input, { stream: true }).',
} as const;
