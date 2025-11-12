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

class TemporalModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'temporal';
  readonly supportedUrls = {};
  modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
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
      .proxyActivities({ startToCloseTimeout: '10 minutes' })
      .invokeModel(this.modelId, options);
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

export class TemporalProvider implements ProviderV2 {
  imageModel(_modelId: string): ImageModelV2 {
    throw new Error('Not implemented');
  }

  languageModel(modelId: string): LanguageModelV2 {
    return new TemporalModel(modelId);
  }

  textEmbeddingModel(_modelId: string): EmbeddingModelV2<string> {
    throw new Error('Not implemented');
  }
}

export const temporalProvider: TemporalProvider = new TemporalProvider();
