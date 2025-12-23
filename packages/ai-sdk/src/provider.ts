import type {
  EmbeddingModelV3,
  EmbeddingModelV3CallOptions,
  EmbeddingModelV3Result,
  ImageModelV3,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  ProviderV3,
  TranscriptionModelV3,
} from '@ai-sdk/provider';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';

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
  languageModel?: ActivityOptions;

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
export class TemporalLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'temporal';

  constructor(
    readonly modelId: string,
    readonly options?: ActivityOptions
  ) {}

  get supportedUrls(): Record<string, RegExp[]> {
    return {};
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
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

  doStream(_options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
    throw ApplicationFailure.nonRetryable('Streaming not supported.');
  }
}

/**
 * An embedding model implementation that delegates embedding generation to Temporal activities.
 * This allows workflows to generate embeddings through the Temporal execution model.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TemporalEmbeddingModel implements EmbeddingModelV3 {
  readonly specificationVersion = 'v3';
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

  async doEmbed(options: EmbeddingModelV3CallOptions): Promise<EmbeddingModelV3Result> {
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
export class TemporalProvider implements ProviderV3 {
  readonly specificationVersion = 'v3';

  constructor(readonly options?: TemporalProviderOptions) {}

  imageModel(_modelId: string): ImageModelV3 {
    throw new Error('Not implemented');
  }

  languageModel(modelId: string): LanguageModelV3 {
    return new TemporalLanguageModel(modelId, {
      ...this.options?.default,
      ...this.options?.languageModel,
    });
  }

  embeddingModel(modelId: string): EmbeddingModelV3 {
    return new TemporalEmbeddingModel(modelId, {
      ...this.options?.default,
      ...this.options?.embeddingModel,
    });
  }

  transcriptionModel(_modelId: string): TranscriptionModelV3 {
    throw new Error('Not implemented');
  }
}

/**
 * A singleton instance of TemporalProvider for convenient use in applications.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export const temporalProvider: TemporalProvider = new TemporalProvider();
