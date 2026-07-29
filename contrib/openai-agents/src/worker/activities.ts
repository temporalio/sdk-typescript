import type { AgentInputItem, ModelProvider, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { APIError } from 'openai';
import { ApplicationFailure, type Duration } from '@temporalio/common';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import {
  toSerializedStreamEvent,
  type InvokeModelActivityInput,
  type InvokeModelStreamActivityInput,
  type JsonValue,
  type SerializedModelRequest,
  type SerializedModelResponse,
  type SerializedStreamEvent,
} from '../common/serialized-model';
import { startAdaptiveHeartbeat } from './heartbeat';

export function toSerializedModelResponse(response: ModelResponse): SerializedModelResponse {
  return {
    usage: {
      requests: response.usage.requests,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      inputTokensDetails: response.usage.inputTokensDetails,
      outputTokensDetails: response.usage.outputTokensDetails,
      ...(response.usage.requestUsageEntries !== undefined && {
        requestUsageEntries: response.usage.requestUsageEntries.map((entry) => ({
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          totalTokens: entry.totalTokens,
          inputTokensDetails: entry.inputTokensDetails,
          outputTokensDetails: entry.outputTokensDetails,
          endpoint: entry.endpoint,
        })),
      }),
    } as JsonValue,
    output: response.output as unknown as JsonValue[],
    responseId: response.responseId,
    providerData: response.providerData as Record<string, JsonValue> | undefined,
  };
}

function fromSerializedModelRequest(wire: SerializedModelRequest): ModelRequest {
  return {
    systemInstructions: wire.systemInstructions,
    input: wire.input as string | AgentInputItem[],
    modelSettings: wire.modelSettings,
    tools: wire.tools,
    toolsExplicitlyProvided: wire.toolsExplicitlyProvided,
    outputType: wire.outputType,
    handoffs: wire.handoffs,
    // Indexed access: Prompt/ModelTracing not exported by @openai/agents-core.
    prompt: wire.prompt as ModelRequest['prompt'],
    previousResponseId: wire.previousResponseId,
    conversationId: wire.conversationId,
    tracing: wire.tracing as ModelRequest['tracing'],
    overridePromptModel: wire.overridePromptModel,
  };
}

function toModelInvocationFailure(error: unknown): ApplicationFailure {
  if (error instanceof APIError) {
    const status = error.status;
    const headers = error.headers;

    // Prefer retry-after-ms (ms precision) over Retry-After (seconds).
    let nextRetryDelay: number | undefined;
    if (headers) {
      const ms = headers.get('retry-after-ms');
      if (ms) {
        const parsed = parseFloat(ms);
        if (!Number.isNaN(parsed)) nextRetryDelay = parsed;
      }
      if (nextRetryDelay === undefined) {
        const s = headers.get('retry-after');
        if (s) {
          const parsed = parseFloat(s);
          if (!Number.isNaN(parsed)) nextRetryDelay = parsed * 1000;
        }
      }
    }

    // `x-should-retry` overrides status-based classification.
    let nonRetryable: boolean;
    const shouldRetry = headers?.get('x-should-retry');
    if (shouldRetry === 'true') {
      nonRetryable = false;
    } else if (shouldRetry === 'false') {
      nonRetryable = true;
    } else if (status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)) {
      nonRetryable = false;
    } else {
      nonRetryable = true;
    }

    let type: string;
    if (status === 429) type = 'ModelInvocationError.RateLimit';
    else if (status === 401 || status === 403) type = 'ModelInvocationError.Authentication';
    else if (status === 400 || status === 422) type = 'ModelInvocationError.BadRequest';
    else if (status === 408) type = 'ModelInvocationError.Timeout';
    else if (status === 409) type = 'ModelInvocationError.Conflict';
    else if (status !== undefined && status >= 500) type = 'ModelInvocationError.ServerError';
    else type = 'ModelInvocationError';

    return ApplicationFailure.create({
      message: `Model invocation failed: ${error.message}`,
      type,
      nonRetryable,
      cause: error,
      ...(nextRetryDelay !== undefined ? { nextRetryDelay } : {}),
    });
  }

  // Non-APIError: wrap and let Temporal's retry policy decide.
  const message = error instanceof Error ? error.message : String(error);
  return ApplicationFailure.create({
    message: `Model invocation failed: ${message}`,
    type: 'ModelInvocationError',
    nonRetryable: false,
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}

/**
 * Creates the model Activity functions registered with the Worker. Activities
 * use the provided ModelProvider to resolve models and execute LLM calls.
 */
export function createModelActivity(modelProvider: ModelProvider): {
  invokeModelActivity: (input: InvokeModelActivityInput) => Promise<SerializedModelResponse>;
  invokeModelStreamActivity: (input: InvokeModelStreamActivityInput) => Promise<SerializedStreamEvent[]>;
} {
  return {
    async invokeModelActivity(input: InvokeModelActivityInput): Promise<SerializedModelResponse> {
      // Start heartbeating before resolving the model — getModel() can be slow
      // for providers that do I/O (e.g. token fetch), and we want heartbeats
      // running through that wait.
      const stopHeartbeat = startAdaptiveHeartbeat();

      try {
        const model = await Promise.resolve(modelProvider.getModel(input.modelName));
        const response = await model.getResponse(fromSerializedModelRequest(input.request));
        return toSerializedModelResponse(response);
      } catch (error) {
        throw toModelInvocationFailure(error);
      } finally {
        stopHeartbeat();
      }
    },

    async invokeModelStreamActivity(input: InvokeModelStreamActivityInput): Promise<SerializedStreamEvent[]> {
      const stopHeartbeat = startAdaptiveHeartbeat();

      try {
        const model = await Promise.resolve(modelProvider.getModel(input.modelName));
        const events: SerializedStreamEvent[] = [];
        const stream = WorkflowStreamClient.fromWithinActivity(
          input.streamingBatchInterval !== undefined
            ? { batchInterval: input.streamingBatchInterval as Duration }
            : undefined
        );
        const topic = stream.topic<StreamEvent>(input.streamingTopic);

        // Drain the publisher explicitly rather than via `await using` so a model
        // error always wins over a secondary flush failure: a model error rethrows
        // even if the drain also throws; a clean run still surfaces drain failures.
        let modelError: unknown;
        try {
          for await (const event of model.getStreamedResponse(fromSerializedModelRequest(input.request))) {
            events.push(toSerializedStreamEvent(event));
            topic.publish(event);
          }
        } catch (error) {
          modelError = error;
        }

        try {
          await stream[Symbol.asyncDispose]();
        } catch (drainError) {
          if (modelError === undefined) throw drainError;
        }
        if (modelError !== undefined) throw modelError;

        return events;
      } catch (error) {
        throw toModelInvocationFailure(error);
      } finally {
        stopHeartbeat();
      }
    },
  };
}
