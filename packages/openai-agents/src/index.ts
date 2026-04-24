/**
 * @temporalio/openai-agents — Temporal integration for the OpenAI Agents SDK.
 *
 * Deferred (not in this package):
 * - StatefulMCPServerProvider — persistent MCP server connections across worker lifecycle
 * - nexusOperationAsTool — TS SDK lacks executeNexusOperation; add when available
 * - testing.AgentEnvironment / testing.ResponseBuilders — richer test harness beyond FakeModel
 * - Trace interceptor — bridge agent traces to Temporal OpenTelemetry spans
 * - workflowFailureExceptionTypes registration (TS SDK doesn't support)
 */

// Main entry — all public exports (plugin, activities, workflow utilities, testing namespace, errors)

export { OpenAIAgentsPlugin, createOpenAIAgentsPlugin } from './plugin';
export type { OpenAIAgentsPluginOptions } from './plugin';
export { createModelActivity } from './activities';
export type { ActivityModelInput } from './model-stub';
export type { ModelActivityParameters, ModelSummaryProvider, AgentInputItem } from './model-parameters';
export { DEFAULT_MODEL_ACTIVITY_PARAMETERS } from './model-parameters';
export { ToolSerializationError } from './tools';
export type { ActivityToolDefinition, ActivityAsToolOptions, JsonObjectSchema } from './tools';
export { StatelessMCPServerProvider } from './mcp';
export type {
  StatelessMcpServerOptions,
  StatelessMCPServerFactory,
  TemporalMCPServer,
  MCPToolDefinition,
  MCPPromptDefinition,
  MCPCallToolResult,
} from './mcp';
export { AgentsWorkflowError } from './errors';

export { isInWorkflow, isReplaying, getWorkflowTracingConfig } from './tracing';

export * as testing from './testing';
