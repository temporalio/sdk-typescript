import { Model } from '@strands-agents/sdk';
import type {
  BaseModelConfig,
  Message,
  ModelStreamEvent,
  StreamOptions,
} from '@strands-agents/sdk';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import type { Duration } from '@temporalio/common/lib/time';
import type {
  InvokeModelInput,
  InvokeModelStreamingInput,
  ModelActivity,
} from './model-activity';

const STRUCTURED_OUTPUT_DISABLED =
  'TemporalModel.structuredOutput is not supported. Use ' +
  'TemporalAgent({ structuredOutputSchema: ... }) which routes structured ' +
  'output through stream() via the structured-output tool.';

/**
 * Options for {@link TemporalModel}.
 *
 * The {@link ActivityOptions} are applied to every activity invocation
 * `stream()` schedules. `streamingTopic` and `streamingBatchInterval`
 * forward {@link ModelStreamEvent}s on a {@link WorkflowStream} as
 * they are produced inside the model activity.
 */
export interface TemporalModelOptions {
  modelName?: string;
  activityOptions?: ActivityOptions;
  streamingTopic?: string;
  streamingBatchInterval?: Duration;
}

/**
 * A Strands {@link Model} whose {@link Model.stream} runs as a Temporal
 * activity. Constructing a `TemporalModel` does no I/O, so instances are
 * safe to create at module load time.
 *
 * The `modelName` selects which factory the plugin will invoke worker-side;
 * it must match a key in {@link StrandsPlugin}'s `models` map. A name not
 * present in `models` raises an error inside the model activity at first call.
 */
export class TemporalModel extends Model<BaseModelConfig> {
  private readonly modelName?: string;
  private readonly activityOptions: ActivityOptions;
  private readonly streamingTopic?: string;
  private readonly streamingBatchInterval: Duration;

  constructor(options: TemporalModelOptions = {}) {
    super();
    this.modelName = options.modelName;
    this.activityOptions = options.activityOptions ?? {};
    this.streamingTopic = options.streamingTopic;
    this.streamingBatchInterval = options.streamingBatchInterval ?? '100 milliseconds';
  }

  override updateConfig(_config: BaseModelConfig): void {
    // No-op; the real model is configured worker-side via the plugin's factories.
  }

  override getConfig(): BaseModelConfig {
    return {};
  }

  override async *stream(
    messages: Message[],
    options?: StreamOptions
  ): AsyncIterable<ModelStreamEvent> {
    const proxiedActivities = workflow.proxyActivities<{
      invokeModel(input: InvokeModelInput): Promise<ModelStreamEvent[]>;
      invokeModelStreaming(input: InvokeModelStreamingInput): Promise<ModelStreamEvent[]>;
    }>({
      startToCloseTimeout: '10 minutes',
      ...this.activityOptions,
    });

    const events = this.streamingTopic
      ? await proxiedActivities.invokeModelStreaming({
          modelName: this.modelName,
          messages,
          options,
          streamingTopic: this.streamingTopic,
          streamingBatchInterval: this.streamingBatchInterval,
        })
      : await proxiedActivities.invokeModel({
          modelName: this.modelName,
          messages,
          options,
        });

    for (const event of events) {
      yield event;
    }
  }
}

/** Type tag used only to forward the `ModelActivity` type from the activity side. */
export type _ModelActivityRef = ModelActivity;

export function rejectStructuredOutput(): never {
  throw ApplicationFailure.nonRetryable(STRUCTURED_OUTPUT_DISABLED);
}
