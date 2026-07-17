import type { ReadableStreamDefaultController } from 'node:stream/web';
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
  ImageModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  ProviderV4,
} from '@ai-sdk/provider';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import type { Duration } from '@temporalio/common/lib/time';

// `ReadableStream` is a sandbox global; type-only import keeps `node:stream/web`
// out of the workflow bundle (es2023 lib has no DOM types).
declare const ReadableStream: typeof import('node:stream/web').ReadableStream;

/**
 * Options for configuring the TemporalProvider with per-model activity settings.
 */
export interface TemporalProviderOptions {
  /**
   * Default activity options applied to all model types.
   * These can be overridden by model-specific options.
   */
  default?: ActivityOptions;

  /**
   * Activity options specific to language model calls.
   * Merged with default options, with these taking precedence.
   */
  languageModel?: ActivityOptions & {
    /**
     * Topic name on the workflow's stream that streaming model calls publish
     * raw stream parts to. When set, `doStream` is enabled and routes through
     * the streaming activity; when unset, `doStream` throws. Pick a unique
     * name per concurrent streaming call to keep event streams separable.
     */
    streamingTopic?: string;

    /**
     * Batch interval for the per-activity `WorkflowStreamClient` that
     * publishes stream parts back to the workflow. Lower values reduce
     * latency at the cost of more signal traffic. Defaults to 100ms.
     */
    streamingBatchInterval?: Duration;
  };

  /**
   * Activity options specific to embedding model calls.
   * Merged with default options, with these taking precedence.
   */
  embeddingModel?: ActivityOptions;
}

/**
 * A language model implementation that delegates AI model calls to Temporal activities.
 * This allows workflows to invoke AI models through the Temporal execution model.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TemporalLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'temporal';
  private readonly streamingTopic: string | undefined;
  private readonly streamingBatchInterval: Duration | undefined;

  constructor(
    readonly modelId: string,
    readonly options?: ActivityOptions & { streamingTopic?: string; streamingBatchInterval?: Duration }
  ) {
    this.streamingTopic = options?.streamingTopic;
    this.streamingBatchInterval = options?.streamingBatchInterval;
  }

  get supportedUrls(): Record<string, RegExp[]> {
    return {};
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const activities = workflow.proxyActivities({
      startToCloseTimeout: '10 minutes',
      ...this.options,
    });
    const result = await activities.invokeModel!({ modelId: this.modelId, options });
    if (result === undefined) {
      throw ApplicationFailure.nonRetryable('Received undefined response from model activity.');
    }
    if (result.response !== undefined && result.response.timestamp) {
      const timestamp = new Date(result.response.timestamp);
      // Only set if it's a valid date
      if (!isNaN(timestamp.getTime())) {
        result.response.timestamp = timestamp;
      }
    }
    return result;
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    if (this.streamingTopic === undefined) {
      throw ApplicationFailure.nonRetryable(
        'Streaming not enabled. Set streamingTopic in languageModel provider options.'
      );
    }

    // Call the streaming activity, which publishes tokens via stream
    // and returns the accumulated result.
    const activities = workflow.proxyActivities({
      startToCloseTimeout: '10 minutes',
      ...this.options,
    });
    const result = await activities.invokeModelStreaming!({
      modelId: this.modelId,
      options,
      streamingTopic: this.streamingTopic,
      streamingBatchInterval: this.streamingBatchInterval,
    });
    if (result === undefined) {
      throw ApplicationFailure.nonRetryable('Received undefined response from streaming model activity.');
    }

    // Wrap the accumulated result as a ReadableStream that replays the content.
    // Real-time token streaming already happened via stream in the activity.
    const stream = new ReadableStream({
      start(controller: ReadableStreamDefaultController) {
        controller.enqueue({ type: 'stream-start', warnings: result.warnings ?? [] });
        let partIndex = 0;
        for (const item of result.content ?? []) {
          const id = `part-${partIndex++}`;
          if (item.type === 'text') {
            controller.enqueue({ type: 'text-start', id });
            controller.enqueue({ type: 'text-delta', id, delta: item.text });
            controller.enqueue({ type: 'text-end', id });
          } else if (item.type === 'reasoning') {
            controller.enqueue({ type: 'reasoning-start', id });
            controller.enqueue({ type: 'reasoning-delta', id, delta: item.text });
            controller.enqueue({ type: 'reasoning-end', id });
          } else {
            controller.enqueue(item);
          }
        }
        controller.enqueue({
          type: 'finish',
          finishReason: result.finishReason,
          usage: result.usage,
        });
        controller.close();
      },
    });

    return { stream, request: result.request, response: result.response };
  }
}

/**
 * An embedding model implementation that delegates embedding generation to Temporal activities.
 * This allows workflows to generate embeddings through the Temporal execution model.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TemporalEmbeddingModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'temporal';
  /**
   * Undefined to let the underlying provider handle chunking, as it knows its own limits.
   */
  readonly maxEmbeddingsPerCall = undefined;
  /**
   * Indicates the underlying embedding model API can handle concurrent requests.
   * Set to true since we delegate to the actual provider which manages its own concurrency.
   */
  readonly supportsParallelCalls = true;

  constructor(
    readonly modelId: string,
    readonly options?: ActivityOptions
  ) {}

  async doEmbed(options: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    const activities = workflow.proxyActivities({
      startToCloseTimeout: '10 minutes',
      ...this.options,
    });
    const result = await activities.invokeEmbeddingModel!({
      modelId: this.modelId,
      values: options.values,
      providerOptions: options.providerOptions,
      headers: options.headers,
      // Note: abortSignal is not serializable, Temporal's cancellation handles this
    });
    if (result === undefined) {
      throw ApplicationFailure.nonRetryable('Received undefined response from embedding model activity.');
    }
    return result;
  }
}

/**
 * A Temporal-specific provider implementation that creates AI models which execute
 * through Temporal activities. This provider integrates AI SDK models with Temporal's
 * execution model to ensure reliable, durable AI model invocations.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TemporalProvider implements ProviderV4 {
  readonly specificationVersion = 'v4';

  constructor(readonly options?: TemporalProviderOptions) {}

  imageModel(_modelId: string): ImageModelV4 {
    throw new Error('Not implemented');
  }

  languageModel(modelId: string): LanguageModelV4 {
    return new TemporalLanguageModel(modelId, {
      ...this.options?.default,
      ...this.options?.languageModel,
    });
  }

  embeddingModel(modelId: string): EmbeddingModelV4 {
    return new TemporalEmbeddingModel(modelId, {
      ...this.options?.default,
      ...this.options?.embeddingModel,
    });
  }
}

/**
 * A singleton instance of TemporalProvider for convenient use in applications.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export const temporalProvider: TemporalProvider = new TemporalProvider();
