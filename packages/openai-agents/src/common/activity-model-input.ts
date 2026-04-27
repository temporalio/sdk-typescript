import type { ModelSettings, SerializedHandoff, SerializedOutputType, SerializedTool } from '@openai/agents-core';

/**
 * Serializable subset of ModelRequest that can be sent to an activity.
 * Strips non-serializable fields like AbortSignal.
 */
export interface ActivityModelInput {
  modelName: string;
  request: {
    systemInstructions?: string;
    input: unknown;
    // Prompt and ModelTracing are not publicly exported from @openai/agents-core
    prompt?: unknown;
    previousResponseId?: string;
    conversationId?: string;
    modelSettings: ModelSettings;
    tools: SerializedTool[];
    toolsExplicitlyProvided?: boolean;
    outputType: SerializedOutputType;
    handoffs: SerializedHandoff[];
    tracing: unknown;
    overridePromptModel?: boolean;
  };
}
