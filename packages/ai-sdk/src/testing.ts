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

export type ModelResponse = {
  content: Array<LanguageModelV2Content>;
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  providerMetadata?: SharedV2ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
  warnings: Array<LanguageModelV2CallWarning>;
};

export class TestModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = "temporal";
  readonly supportedUrls = {}
  readonly modelId = "TestModel"
  private generator: Generator<ModelResponse>;
  private done: boolean = false;

  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }

  async doGenerate(
    _: LanguageModelV2CallOptions
  ): Promise<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    if (this.done) {
      throw new Error("Called generate more times than responses given to the test generator");
    }

    const result = this.generator.next();
    this.done = result.done ?? false;
    return result.value;
  }

  doStream(
    options: LanguageModelV2CallOptions
  ): PromiseLike<{
    stream: any;
    request?: { body?: unknown };
    response?: { headers?: SharedV2Headers };
  }> {
    throw new Error('Streaming not supported.');
  }
}

export class TestProvider implements ProviderV2 {
  private generator: Generator<ModelResponse>;
  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }
  imageModel(modelId: string): ImageModelV2 {
    throw new Error('Not implemented');
  }

  languageModel(modelId: string): LanguageModelV2 {
    return new TestModel(this.generator);
  }

  textEmbeddingModel(modelId: string): EmbeddingModelV2<string> {
    throw new Error('Not implemented');
  }
}