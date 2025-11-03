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

export class ModelGenerator {
  private readonly generatorFactory: (name: string) => Generator<ModelResponse>;
  private generator?: Generator<ModelResponse>;
  private done: boolean = false;
  constructor(generatorFactory: (name: string) => Generator<ModelResponse>) {
    this.generatorFactory = generatorFactory;
  }

  generate(name: string): PromiseLike<ModelResponse> {
    if (this.generator === undefined) {
      this.generator = this.generatorFactory(name);
    }
    if (this.done) {
      throw new Error("Called generate more times than responses given to the test generator");
    }
    const next = this.generator.next();
    this.done = next.done ?? false;
    return next.value
  }
}

export class TestModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = "temporal";
  readonly supportedUrls = {}
  readonly modelId = "TestModel"
  private generator: ModelGenerator;

  constructor(generator: ModelGenerator) {
    this.generator = generator;
  }

  async doGenerate(
    options: LanguageModelV2CallOptions
  ): Promise<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    const name = options.providerOptions?.test?.name?.toString() ?? "";
    console.log("Generating ", name);
    return await this.generator.generate(name)
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
  private generator: ModelGenerator;
  constructor(generator: ModelGenerator) {
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