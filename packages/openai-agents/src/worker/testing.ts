import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents-core';

export class FakeModel implements Model {
  private getNext: () => ModelResponse;

  constructor(source: ModelResponse[] | Generator<ModelResponse>) {
    if (Array.isArray(source)) {
      let index = 0;
      this.getNext = () => {
        if (index >= source.length) {
          throw new Error(
            `FakeModel: no more canned responses (called ${index + 1} times, only ${source.length} responses provided)`
          );
        }
        return source[index++]!;
      };
    } else {
      let done = false;
      const gen = source;
      this.getNext = () => {
        if (done) throw new Error('FakeModel: generator exhausted');
        const result = gen.next();
        if (result.done) {
          done = true;
          throw new Error('FakeModel: generator exhausted');
        }
        return result.value;
      };
    }
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    return this.getNext();
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not supported in FakeModel');
  }
}

export class FakeModelProvider implements ModelProvider {
  private model: FakeModel;

  constructor(source: ModelResponse[] | (() => Generator<ModelResponse>)) {
    this.model = typeof source === 'function' ? new FakeModel(source()) : new FakeModel(source);
  }

  getModel(_name?: string): Model {
    return this.model;
  }
}

function fakeUsage(outputTokens: number): Usage {
  return new Usage({
    requests: 1,
    inputTokens: 10,
    outputTokens,
    totalTokens: 10 + outputTokens,
  });
}

export function textResponse(text: string): ModelResponse {
  const output: AgentOutputItem[] = [
    {
      type: 'message',
      id: 'msg_fake_001',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      status: 'completed',
    },
  ];
  return { output, usage: fakeUsage(text.length) };
}

export function toolCallResponse(toolName: string, args: Record<string, unknown>): ModelResponse {
  const output: AgentOutputItem[] = [
    {
      type: 'function_call',
      name: toolName,
      arguments: JSON.stringify(args),
      callId: `call_fake_${toolName}`,
      status: 'completed',
    },
  ];
  return { output, usage: fakeUsage(20) };
}

export function handoffResponse(handoffToolName: string, args: Record<string, unknown> = {}): ModelResponse {
  return toolCallResponse(handoffToolName, args);
}

export function multiToolCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): ModelResponse {
  const output: AgentOutputItem[] = calls.map((c) => ({
    type: 'function_call' as const,
    name: c.name,
    arguments: JSON.stringify(c.args),
    callId: `call_fake_${c.name}`,
    status: 'completed' as const,
  }));
  return { output, usage: fakeUsage(20) };
}

export const ResponseBuilders = {
  text: textResponse,
  toolCall: toolCallResponse,
  handoff: handoffResponse,
  multiToolCall: multiToolCallResponse,
};
