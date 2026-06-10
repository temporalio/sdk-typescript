import type { ModelSettings, SerializedHandoff, SerializedOutputType, SerializedTool } from '@openai/agents-core';

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
