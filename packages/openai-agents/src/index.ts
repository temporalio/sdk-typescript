/**
 * @temporalio/openai-agents — Temporal integration for the OpenAI Agents SDK.
 *
 * Deferred (not in this package):
 * - StatefulMCPServerProvider — persistent MCP server connections across worker lifecycle
 * - nexusOperationAsTool — TS SDK lacks executeNexusOperation; add when available
 * - testing.AgentEnvironment / testing.ResponseBuilders — richer test harness beyond FakeModel
 * - workflowFailureExceptionTypes registration (TS SDK doesn't support)
 */

// Main entry — all public exports (plugin, activities, workflow utilities, testing namespace, errors)

export { OpenAIAgentsPlugin } from './worker/plugin';
export type { OpenAIAgentsPluginOptions } from './worker/plugin';
export { createModelActivity } from './worker/activities';
export { toSerializedModelResponse } from './worker/activities';
export { StatelessMCPServerProvider } from './worker/mcp-provider';
export type { StatelessMCPServerFactory, MCPToolDefinition, MCPCallToolResult } from './worker/mcp-provider';
export {
  WIRE_VERSION,
  type SerializedModelRequest,
  type SerializedModelResponse,
  type InvokeModelActivityInput,
  type JsonValue,
} from './common/serialized-model';
export type { ModelActivityParameters, ModelSummaryProvider, AgentInputItem } from './common/model-parameters';
export { DEFAULT_MODEL_ACTIVITY_PARAMETERS } from './common/model-parameters';
export { AgentsWorkflowError } from './common/errors';
export { ToolSerializationError } from './workflow/tools';
export type { ActivityToolDefinition, ActivityAsToolOptions, JsonObjectSchema } from './workflow/tools';
export type { StatelessMcpServerOptions, TemporalMCPServer, MCPPromptDefinition } from './workflow/mcp-client';
export {
  isInWorkflow,
  isReplaying,
  getWorkflowTracingConfig,
  TemporalTracingProcessor,
  ensureTracingProcessorRegistered,
} from './workflow/tracing';

export * as testing from './worker/testing';
