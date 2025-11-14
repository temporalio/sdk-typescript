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

/**
 * Response structure for AI model invocations, containing content, metadata, and usage information.
 * Used primarily for testing scenarios to mock AI model responses.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export type ModelResponse = {
  content: Array<LanguageModelV2Content>;
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  providerMetadata?: SharedV2ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
  warnings: Array<LanguageModelV2CallWarning>;
};

/**
 * A test implementation of LanguageModelV2 that returns predefined responses from a generator.
 * This class is useful for testing workflows that use AI models without making actual API calls.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TestModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'temporal';
  readonly supportedUrls = {};
  readonly modelId = 'TestModel';
  private generator: Generator<ModelResponse>;
  private done: boolean = false;

  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }

  async doGenerate(_: LanguageModelV2CallOptions): Promise<{
    content: Array<LanguageModelV2Content>;
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    providerMetadata?: SharedV2ProviderMetadata;
    request?: { body?: unknown };
    response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
    warnings: Array<LanguageModelV2CallWarning>;
  }> {
    if (this.done) {
      throw new Error('Called generate more times than responses given to the test generator');
    }

    const result = this.generator.next();
    this.done = result.done ?? false;
    console.log("Returning result", result);
    return result.value;
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
 * A test provider implementation that creates TestModel instances for testing purposes.
 * This provider allows testing AI-enabled workflows without external API dependencies.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export class TestProvider implements ProviderV2 {
  private generator: Generator<ModelResponse>;
  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }
  imageModel(_modelId: string): ImageModelV2 {
    throw new Error('Not implemented');
  }

  languageModel(_modelId: string): LanguageModelV2 {
    return new TestModel(this.generator);
  }

  textEmbeddingModel(_modelId: string): EmbeddingModelV2<string> {
    throw new Error('Not implemented');
  }
}
