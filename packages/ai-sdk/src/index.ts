// eslint-disable-next-line import/no-unassigned-import
import 'ai'
// eslint-disable-next-line import/no-unassigned-import
import "./load-polyfills"

import {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ResponseMetadata,
  LanguageModelV2TextPart,
  LanguageModelV2Usage,
  ProviderV2,
  SharedV2Headers,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider';
import * as workflow from '@temporalio/workflow';

export async function invokeModel(modelId: string, options: LanguageModelV2CallOptions): Promise<{
  content: Array<LanguageModelV2Content>;
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  providerMetadata?: SharedV2ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
  warnings: Array<LanguageModelV2CallWarning>;
}> {
  const model = (globalThis.AI_SDK_DEFAULT_PROVIDER! as TemporalProvider)._provider.languageModel(modelId)
  return await model.doGenerate(options)
}

class TemporalModel implements LanguageModelV2 {

  readonly specificationVersion = 'v2';
  readonly provider = "temporal";
  readonly supportedUrls = {}
  modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
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
    const result = await workflow.proxyActivities({startToCloseTimeout: '10 minutes'}).invokeModel(this.modelId, options);
    if (result.response !== undefined) {
      result.response.timestamp = new Date(result.response.timestamp)
    }
    return result;
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

export class TemporalProvider implements ProviderV2 {
  public _provider: ProviderV2;
  constructor(provider: ProviderV2) {
    this._provider = provider;
  }

  imageModel(modelId: string): ImageModelV2 {
    throw new Error('Not implemented');
  }

  languageModel(modelId: string): LanguageModelV2 {
    return new TemporalModel(modelId);
  }

  textEmbeddingModel(modelId: string): EmbeddingModelV2<string> {
    throw new Error('Not implemented');
  }
}

type ModelGenerator = (prompt: string) => PromiseLike<{
  content: Array<LanguageModelV2Content>;
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  providerMetadata?: SharedV2ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
  warnings: Array<LanguageModelV2CallWarning>;
}>

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
    const lastMessage = options.prompt.at(options.prompt.length - 1);
    if (lastMessage === undefined) {
      throw new Error("Test model couldn't find the last prompt message");
    }
    console.log(lastMessage.content)
    let prompt;
    if (typeof lastMessage.content === "string") {
      prompt = lastMessage.content;
    } else {
      if (lastMessage.content.length !== 1) {
        throw new Error("Test model only supports a single content.");
      }
      if (lastMessage.content.at(0)?.type !== "text") {
        throw new Error("Test model only supports text content.");
      }
      prompt = (lastMessage.content.at(0) as LanguageModelV2TextPart).text
    }
    return await this.generator(prompt)
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