import type { Model, ModelProvider, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';

export class FakeModel implements Model {
  private responses: ModelResponse[];
  private index = 0;

  constructor(responses: ModelResponse[]) {
    this.responses = responses;
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    if (this.index >= this.responses.length) {
      throw new Error(
        `FakeModel: no more canned responses (called ${this.index + 1} times, only ${
          this.responses.length
        } responses provided)`
      );
    }
    return this.responses[this.index++]!;
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not supported in FakeModel');
  }
}

export class GeneratorFakeModel implements Model {
  private generator: Generator<ModelResponse>;
  private done = false;

  constructor(generator: Generator<ModelResponse>) {
    this.generator = generator;
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    if (this.done) {
      throw new Error('GeneratorFakeModel: generator exhausted');
    }
    const result = this.generator.next();
    if (result.done) {
      this.done = true;
      throw new Error('GeneratorFakeModel: generator exhausted');
    }
    return result.value;
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not supported in GeneratorFakeModel');
  }
}

export class FakeModelProvider implements ModelProvider {
  private model: FakeModel;

  constructor(responses: ModelResponse[]) {
    this.model = new FakeModel(responses);
  }

  getModel(_name?: string): Model {
    return this.model;
  }
}

export class GeneratorFakeModelProvider implements ModelProvider {
  private model: GeneratorFakeModel;

  constructor(generatorFactory: () => Generator<ModelResponse>) {
    this.model = new GeneratorFakeModel(generatorFactory());
  }

  getModel(_name?: string): Model {
    return this.model;
  }
}

export function textResponse(text: string): ModelResponse {
  return {
    output: [
      {
        type: 'message',
        id: 'msg_fake_001',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [],
          },
        ],
        status: 'completed',
      },
    ] as any,
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: text.length,
      totalTokens: 10 + text.length,
      inputTokensDetails: [],
      outputTokensDetails: [],
    } as any,
  };
}

export function toolCallResponse(toolName: string, args: Record<string, unknown>): ModelResponse {
  return {
    output: [
      {
        type: 'function_call',
        name: toolName,
        arguments: JSON.stringify(args),
        callId: `call_fake_${toolName}`,
        status: 'completed',
      },
    ] as any,
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      inputTokensDetails: [],
      outputTokensDetails: [],
    } as any,
  };
}

export function handoffResponse(handoffToolName: string, args: Record<string, unknown> = {}): ModelResponse {
  return toolCallResponse(handoffToolName, args);
}

export function multiToolCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): ModelResponse {
  return {
    output: calls.map((c) => ({
      type: 'function_call',
      name: c.name,
      arguments: JSON.stringify(c.args),
      callId: `call_fake_${c.name}`,
      status: 'completed',
    })) as any,
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      inputTokensDetails: [],
      outputTokensDetails: [],
    } as any,
  };
}
