import type {
  ModelSettings,
  SerializedHandoff,
  SerializedOutputType,
  SerializedTool,
  StreamEvent,
} from '@openai/agents-core';

export type JsonValue = null | string | number | boolean | JsonValue[] | { [k: string]: JsonValue };

// JSON-safe projection of upstream `ModelRequest`. `signal` (AbortSignal) is
// intentionally excluded — Temporal cancellation supplies the equivalent.
export interface SerializedModelRequest {
  systemInstructions?: string;
  input: JsonValue;
  modelSettings: ModelSettings;
  tools: SerializedTool[];
  toolsExplicitlyProvided?: boolean;
  outputType: SerializedOutputType;
  handoffs: SerializedHandoff[];
  prompt?: JsonValue;
  previousResponseId?: string;
  conversationId?: string;
  tracing: JsonValue;
  overridePromptModel?: boolean;
}

export interface SerializedModelResponse {
  usage: JsonValue;
  output: JsonValue[];
  responseId?: string;
  providerData?: Record<string, JsonValue>;
}

export interface InvokeModelActivityInput {
  modelName: string;
  request: SerializedModelRequest;
}

export type SerializedStreamEvent = JsonValue;

// StreamEvents are JSON-by-construction (zod-inferred), so the cast is a no-op at
// runtime. Centralize it here so the boundary assumption is documented, not scattered.
export function toSerializedStreamEvent(event: StreamEvent): SerializedStreamEvent {
  return event as unknown as SerializedStreamEvent;
}

export function fromSerializedStreamEvent(event: SerializedStreamEvent): StreamEvent {
  return event as unknown as StreamEvent;
}

export interface InvokeModelStreamActivityInput {
  modelName: string;
  request: SerializedModelRequest;
  streamingTopic: string;
  /** Stream publisher batch flush interval, as a Duration string. */
  streamingBatchInterval?: string;
}
