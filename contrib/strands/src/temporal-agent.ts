import { Agent } from '@strands-agents/sdk';
import type { AgentConfig } from '@strands-agents/sdk';
import type { ActivityOptions } from '@temporalio/workflow';
import type { Duration } from '@temporalio/common/lib/time';
import { TemporalModel } from './temporal-model';

const SNAPSHOT_DISABLED =
  'TemporalAgent disables takeSnapshot()/loadSnapshot(). Temporal workflows ' +
  'already persist agent state durably via the event history at a finer ' +
  'granularity than Strands snapshots. Remove the snapshot call and rely on ' +
  "Temporal's durable execution instead.";

const RETRY_STRATEGY_DISABLED =
  'TemporalAgent disables Strands retries; configure retries via retryPolicy ' +
  "in the model activity options on TemporalAgent, and on the activity options " +
  'passed to workflow.activityAsTool, workflow.activityAsHook, or TemporalMCPClient. ' +
  'Remove retryStrategy from TemporalAgent(...) or pass retryStrategy: null.';

/**
 * Options for {@link TemporalAgent}.
 *
 * Accepts everything {@link AgentConfig} accepts except `model` (which is a
 * factory name selecting a worker-side {@link Model}, not an instance) and
 * `retryStrategy` (always disabled — Temporal handles retries via
 * `activityOptions.retry`).
 *
 * The {@link ActivityOptions} apply to every model invocation this agent
 * makes. `streamingTopic`/`streamingBatchInterval` route each
 * {@link ModelStreamEvent} to a {@link WorkflowStream} topic of that name.
 */
export interface TemporalAgentOptions extends Omit<AgentConfig, 'model' | 'retryStrategy'> {
  model?: string;
  activityOptions?: ActivityOptions;
  streamingTopic?: string;
  streamingBatchInterval?: Duration;
}

/**
 * A Strands {@link Agent} that routes every model call through a Temporal
 * activity.
 *
 * `model` is the name of a factory registered in
 * `StrandsPlugin({ models: {...} })`. The `activityOptions` apply to every
 * model invocation this agent makes. All other options are forwarded to
 * Strands' {@link Agent} constructor (`tools`, `plugins`, `systemPrompt`,
 * `structuredOutputSchema`, `messages`, etc.).
 *
 * Strands' `retryStrategy` is disabled; configure retries via
 * `activityOptions.retry` here and on the activity options accepted by
 * {@link activityAsTool}, {@link activityAsHook}, and {@link TemporalMCPClient}.
 */
export class TemporalAgent extends Agent {
  constructor(options: TemporalAgentOptions = {}) {
    const { model, activityOptions, streamingTopic, streamingBatchInterval, ...rest } = options;
    if ((rest as { retryStrategy?: unknown }).retryStrategy !== undefined) {
      throw new Error(RETRY_STRATEGY_DISABLED);
    }
    const temporalModel = new TemporalModel({
      modelName: model,
      activityOptions,
      streamingTopic,
      streamingBatchInterval,
    });
    super({
      ...rest,
      model: temporalModel,
      retryStrategy: null,
    });
  }

  override takeSnapshot(): never {
    throw new Error(SNAPSHOT_DISABLED);
  }

  override loadSnapshot(): never {
    throw new Error(SNAPSHOT_DISABLED);
  }
}
