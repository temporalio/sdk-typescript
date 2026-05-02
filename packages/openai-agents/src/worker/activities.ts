import type { ModelProvider, ModelRequest, ModelResponse } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import { heartbeat, activityInfo } from '@temporalio/activity';
import {
  type InvokeModelActivityInput,
  type JsonValue,
  type SerializedModelRequest,
  type SerializedModelResponse,
  WIRE_VERSION,
} from '../common/serialized-model';

/** Projects an upstream ModelResponse to its JSON-serializable wire form. */
export function toSerializedModelResponse(response: ModelResponse): SerializedModelResponse {
  return {
    __wireVersion: WIRE_VERSION,
    // Usage is a class with an add() method, but all its data properties are JSON-safe primitives,
    // arrays, or records. The double-cast is needed because TypeScript can't narrow a class to JsonValue.
    usage: response.usage as unknown as JsonValue,
    // AgentOutputItem[] items are Zod-inferred plain objects (no class instances, no methods).
    // JSON round-trip preserves them losslessly. Double-cast needed for the same TS reason.
    output: response.output as unknown as JsonValue[],
    responseId: response.responseId,
    providerData: response.providerData as Record<string, JsonValue> | undefined,
  };
}

function fromSerializedModelRequest(wire: SerializedModelRequest): ModelRequest {
  return {
    systemInstructions: wire.systemInstructions,
    input: wire.input,
    modelSettings: wire.modelSettings,
    tools: wire.tools,
    toolsExplicitlyProvided: wire.toolsExplicitlyProvided,
    outputType: wire.outputType,
    handoffs: wire.handoffs,
    prompt: wire.prompt,
    previousResponseId: wire.previousResponseId,
    conversationId: wire.conversationId,
    tracing: wire.tracing,
    overridePromptModel: wire.overridePromptModel,
    // __wireVersion deliberately stripped — internal protocol field, not part of upstream ModelRequest.
    // Type assertion: JsonValue wire fields are structurally compatible with their upstream types at runtime.
  } as ModelRequest;
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as any;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  return undefined;
}

function getHeader(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as any;
  const h1 = e.headers;
  if (h1) {
    if (typeof h1.get === 'function') {
      const v = h1.get(name);
      if (typeof v === 'string') return v;
    } else if (typeof h1 === 'object' && typeof h1[name] === 'string') {
      return h1[name];
    }
  }
  const h2 = e.response?.headers;
  if (h2) {
    if (typeof h2.get === 'function') {
      const v = h2.get(name);
      if (typeof v === 'string') return v;
    } else if (typeof h2 === 'object' && typeof h2[name] === 'string') {
      return h2[name];
    }
  }
  return undefined;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const shouldRetry = getHeader(error, 'x-should-retry');
  if (shouldRetry === 'true') return true;
  if (shouldRetry === 'false') return false;

  const status = getStatus(error);
  if (status === undefined) {
    return (error as any).response !== undefined;
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true;
  }
  return false;
}

function errorTypeFromStatus(status: number | undefined): string {
  if (status === undefined) return 'ModelInvocationError';
  if (status === 429) return 'ModelInvocationError.RateLimit';
  if (status === 401 || status === 403) return 'ModelInvocationError.Authentication';
  if (status === 408) return 'ModelInvocationError.Timeout';
  if (status === 409) return 'ModelInvocationError.Conflict';
  if (status >= 400 && status < 500) return 'ModelInvocationError.BadRequest';
  if (status >= 500) return 'ModelInvocationError.ServerError';
  return 'ModelInvocationError';
}

function getRetryAfterMs(error: unknown): number | undefined {
  const ms = getHeader(error, 'retry-after-ms');
  if (ms) {
    const parsed = parseFloat(ms);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const s = getHeader(error, 'retry-after');
  if (s) {
    const parsed = parseFloat(s);
    if (!Number.isNaN(parsed)) return parsed * 1000;
  }
  return undefined;
}

/**
 * Creates the model activity functions to be registered with the Worker.
 * The returned activities use the provided ModelProvider to resolve models
 * and execute real LLM calls.
 */
export function createModelActivity(modelProvider: ModelProvider): {
  invokeModelActivity: (input: InvokeModelActivityInput) => Promise<SerializedModelResponse>;
} {
  return {
    async invokeModelActivity(input: InvokeModelActivityInput): Promise<SerializedModelResponse> {
      if (input.request.__wireVersion !== WIRE_VERSION) {
        throw ApplicationFailure.nonRetryable(
          `OpenAI Agents wire version mismatch: payload=${input.request.__wireVersion}, runtime=${WIRE_VERSION}. ` +
            `Upgrade workers and clients together.`,
          'WireVersionMismatch'
        );
      }
      // Shape validation beyond version check is intentionally minimal: no Zod or runtime schema
      // validation. The wire version literal + structural projection in toSerializedModelRequest
      // cover the actual risks (version skew and field leakage). Adding a runtime validator would
      // introduce a dependency with no concrete safety gain — upstream types are JSON-safe by design.

      const model = await Promise.resolve(modelProvider.getModel(input.modelName));

      const info = activityInfo();
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      if (info.heartbeatTimeoutMs && info.heartbeatTimeoutMs > 0) {
        const interval = info.heartbeatTimeoutMs / 2;
        const scheduleHeartbeat = () => {
          heartbeatTimer = setTimeout(() => {
            if (stopped) return;
            try {
              heartbeat();
            } catch {
              // Activity might be cancelled — ignore heartbeat errors
            }
            scheduleHeartbeat();
          }, interval);
        };
        scheduleHeartbeat();
      }

      try {
        const response = await model.getResponse(fromSerializedModelRequest(input.request));
        return toSerializedModelResponse(response);
      } catch (error) {
        const retryable = isRetryableError(error);
        const message = error instanceof Error ? error.message : String(error);
        const retryAfterMs = getRetryAfterMs(error);

        throw ApplicationFailure.create({
          message: `Model invocation failed: ${message}`,
          type: errorTypeFromStatus(getStatus(error)),
          nonRetryable: !retryable,
          cause: error instanceof Error ? error : new Error(String(error)),
          ...(retryAfterMs !== undefined ? { nextRetryDelay: retryAfterMs } : {}),
        });
      } finally {
        stopped = true;
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
        }
      }
    },
  };
}
