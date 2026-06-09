import {
  Usage,
  getCurrentTrace,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents-core';
import { textResponse as _textResponse } from './openai-agents-fakes';

export {
  FakeModel,
  FakeModelProvider,
  textResponse,
  toolCallResponse,
  handoffResponse,
  multiToolCallResponse,
} from './openai-agents-fakes';

/**
 * Helper to create a ModelResponse with a Date field for testing serialization.
 */
export function responseWithDate(text: string): ModelResponse {
  const base = _textResponse(text);
  (base as any).createdAt = new Date('2025-01-01T00:00:00Z');
  return base;
}

/**
 * A model that always throws the given error. Used for testing error handling.
 */
export class ErrorModel implements Model {
  private error: Error;

  constructor(error: Error) {
    this.error = error;
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw this.error;
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw this.error;
  }
}

/**
 * A model provider that returns an ErrorModel. Used for testing model error handling.
 */
export class ErrorModelProvider implements ModelProvider {
  private model: ErrorModel;

  constructor(error: Error) {
    this.model = new ErrorModel(error);
  }

  getModel(_name?: string): Model {
    return this.model;
  }
}

/**
 * A model that captures the last ModelRequest it received.
 * Used for testing that request fields survive serialization through ActivityBackedModel.
 */
export class RequestCapturingModel implements Model {
  public lastRequest: ModelRequest | undefined;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.lastRequest = request;
    const output: AgentOutputItem[] = [
      {
        type: 'message',
        id: 'msg_capture',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'captured' }],
        status: 'completed',
      },
    ];
    return {
      output,
      usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 8, totalTokens: 18 }),
    };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not supported');
  }
}

export class RequestCapturingModelProvider implements ModelProvider {
  public model = new RequestCapturingModel();
  getModel(_name?: string): Model {
    return this.model;
  }
  get lastRequest(): ModelRequest | undefined {
    return this.model.lastRequest;
  }
}

/**
 * A model provider that captures the model name passed to getModel().
 * Used for testing that runConfig.model override reaches the activity.
 */
export class ModelNameCapturingModelProvider implements ModelProvider {
  public capturedModelNames: string[] = [];

  getModel(name?: string): Model {
    this.capturedModelNames.push(name ?? '(default)');
    return new RequestCapturingModel();
  }
}

/**
 * A model that throws an arbitrary value (not necessarily an Error).
 * Used for testing error handling with non-Error throws.
 */
export class ThrowAnythingModel implements Model {
  constructor(private value: unknown) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw this.value;
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw this.value;
  }
}

export class ThrowAnythingModelProvider implements ModelProvider {
  private model: ThrowAnythingModel;

  constructor(value: unknown) {
    this.model = new ThrowAnythingModel(value);
  }

  getModel(_name?: string): Model {
    return this.model;
  }
}

/**
 * A model that captures the current agent trace context during invocation and
 * returns the traceId as the response text. Used for testing trace context
 * propagation across the workflow→activity boundary.
 */
export class TraceCaptureModel implements Model {
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    const traceId = getCurrentTrace()?.traceId ?? 'NO_TRACE';
    const output: AgentOutputItem[] = [
      {
        type: 'message',
        id: 'msg_trace_capture',
        role: 'assistant',
        content: [{ type: 'output_text', text: `TRACE:${traceId}` }],
        status: 'completed',
      },
    ];
    return {
      output,
      usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not supported');
  }
}

export class TraceCaptureModelProvider implements ModelProvider {
  getModel(_name?: string): Model {
    return new TraceCaptureModel();
  }
}
