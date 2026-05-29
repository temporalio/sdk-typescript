import type { MCPServer } from '@openai/agents-core';

export const MCP_LIST_TOOLS_SUFFIX = '-list-tools';
export const MCP_CALL_TOOL_SUFFIX = '-call-tool';
export const MCP_LIST_PROMPTS_SUFFIX = '-list-prompts';
export const MCP_GET_PROMPT_SUFFIX = '-get-prompt';
export const MCP_SERVER_SESSION_SUFFIX = '-server-session';
export const MCP_STATEFUL_SUFFIX = '-stateful';

/** Error type for dedicated-Worker scheduling and heartbeat failures. */
export const DEDICATED_WORKER_FAILURE_TYPE = 'DedicatedWorkerFailure';

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

export interface MCPCallToolResult {
  type: string;
  text: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** Shape registered with `StatelessMCPServerProvider` to serve stateless MCP requests. */
export interface StatelessMCPServerFactory {
  listTools(arg?: unknown): Promise<MCPToolDefinition[]>;
  callTool(arg: {
    toolName: string;
    args: Record<string, unknown> | null;
    factoryArgument?: unknown;
  }): Promise<MCPCallToolResult[]>;
  listPrompts(arg?: unknown): Promise<MCPPromptDefinition[]>;
  getPrompt(arg: {
    promptName: string;
    promptArguments: Record<string, unknown> | null;
    factoryArgument?: unknown;
  }): Promise<unknown>;
}

/** Shape returned by the `serverFactory` passed to `StatefulMCPServerProvider`. */
export interface StatefulMCPServer {
  connect(): Promise<void>;
  cleanup(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(toolName: string, args: Record<string, unknown> | null): Promise<MCPCallToolResult[]>;
  listPrompts?(): Promise<MCPPromptDefinition[]>;
  getPrompt?(name: string, args: Record<string, unknown> | null): Promise<unknown>;
}

/** Workflow-side MCP server handle. */
export interface TemporalMCPServer extends MCPServer {
  listPrompts(factoryArgument?: unknown): Promise<MCPPromptDefinition[]>;
  getPrompt(promptName: string, args?: Record<string, unknown> | null, factoryArgument?: unknown): Promise<unknown>;
}

/**
 * Stateful variant of {@link TemporalMCPServer}. Adds `cleanup()` — the documented
 * lifecycle method users invoke from `finally` blocks after `connect()`.
 */
export interface StatefulTemporalMCPServer extends TemporalMCPServer {
  cleanup(): Promise<void>;
}

// Forwarded per-call (not stored on the provider) so different plugins sharing
// a provider each get their own per-run config.
export interface StatefulMcpActivityInterceptorOptions {
  addTemporalSpans?: boolean;
}

// Input shape of the `${name}-stateful-server-session` Activity.
export interface StatefulMcpServerSessionArgs {
  factoryArgument?: unknown;
  activityInterceptorOptions?: StatefulMcpActivityInterceptorOptions;
}
