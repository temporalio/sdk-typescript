import type { ModelSettings, SerializedHandoff, SerializedOutputType, SerializedTool } from '@openai/agents-core';

/** Current wire protocol version. Activity validates this on every invocation. */
export const WIRE_VERSION = 1;

// Note: Some fields (modelSettings, tools, outputType, handoffs) reference upstream types directly.
// We trust these to remain JSON-safe; if upstream adds a non-serializable field, bump WIRE_VERSION
// and either project or exclude.

/** Recursive JSON-safe type replacing upstream `unknown` fields on the wire. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [k: string]: JsonValue };

/** JSON-serializable projection of upstream `ModelRequest`, sent workflow → activity. */
export interface SerializedModelRequest {
  __wireVersion: typeof WIRE_VERSION;
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
  // tracing is ModelTracing (boolean | 'enabled_without_data') — an enablement flag, not trace context.
  // OTel span context for activity-under-generation nesting is tracked separately (see TemporalTracingProcessor).
  tracing: JsonValue;
  overridePromptModel?: boolean;
  // Excluded by design (must stay in this comment for future contributors):
  //   signal — AbortSignal; not serializable. Temporal cancellation provides equivalent.
}

/** JSON-serializable projection of upstream `ModelResponse`, returned activity → workflow. */
export interface SerializedModelResponse {
  __wireVersion: typeof WIRE_VERSION;
  usage: JsonValue;
  output: JsonValue[];
  responseId?: string;
  /**
   * Provider-specific metadata. Upstream type is `Record<string, any>`.
   *
   * **Coercion warning:** Temporal's JSON codec serializes this field as-is. Non-JSON-primitive
   * values (Date, Map, Set, class instances) will be silently coerced — e.g., Date becomes an
   * ISO 8601 string. Code consuming this field on the workflow side will receive the coerced
   * form, not the original type. If your model provider populates providerData with non-JSON
   * types, handle the coerced representation explicitly.
   */
  providerData?: Record<string, JsonValue>;
  // All upstream ModelResponse fields are present, with types narrowed to JSON-safe equivalents (Usage → JsonValue, etc.).
}

/** Activity input envelope: model name + serialized request. */
export interface InvokeModelActivityInput {
  modelName: string;
  request: SerializedModelRequest;
}
