import {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ResponseMetadata,
  LanguageModelV2Usage,
  ProviderV2,
  SharedV2Headers,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider';
import * as workflow from '@temporalio/workflow';
import { ActivityOptions } from '@temporalio/workflow';

/**
 * A language model implementation that delegates AI model calls to Temporal activities.
 * This allows workflows to invoke AI models through the Temporal execution model.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TemporalLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'temporal';
  readonly supportedUrls = {};

  constructor(readonly modelId: string, readonly options?: ActivityOptions) {
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    const result = await workflow
      .proxyActivities(this.options ?? { startToCloseTimeout: '10 minutes' })
      .invokeModel(this.modelId, options);
    if (result === undefined) {
      throw new Error("Received undefined response from model activity.")
    }
    if (result.response !== undefined) {
      result.response.timestamp = new Date(result.response.timestamp);
    }
    return result;
  }

  doStream(_options: LanguageModelV2CallOptions): PromiseLike<{
    stream: any;
    request?: { body?: unknown };
    response?: { headers?: SharedV2Headers };
  }> {
    throw new Error('Streaming not supported.');
  }
}

/**
 * A Temporal-specific provider implementation that creates AI models which execute
 * through Temporal activities. This provider integrates AI SDK models with Temporal's
 * execution model to ensure reliable, durable AI model invocations.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TemporalProvider implements ProviderV2 {
  constructor(readonly options? : ActivityOptions) {
  }

  imageModel(_modelId: string): ImageModelV2 {
    throw new Error('Not implemented');
  }

  languageModel(modelId: string): LanguageModelV2 {
    return new TemporalLanguageModel(modelId, this.options);
  }

  textEmbeddingModel(_modelId: string): EmbeddingModelV2<string> {
    throw new Error('Not implemented');
  }
}

/**
 * A singleton instance of TemporalProvider for convenient use in applications.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export const temporalProvider: TemporalProvider = new TemporalProvider();
