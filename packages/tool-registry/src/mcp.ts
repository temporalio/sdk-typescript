/**
 * MCP (Model Context Protocol) integration for ToolRegistry.
 *
 * Provides utilities for wrapping MCP tool definitions in a {@link ToolRegistry},
 * enabling use of MCP-sourced tools with Anthropic or OpenAI providers.
 */

import { ToolRegistry } from './registry';

/** MCP-compatible tool descriptor. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Build a {@link ToolRegistry} from a list of MCP tool descriptors.
 *
 * Each MCP tool is registered with a no-op handler (returns empty string).
 * Replace handlers by calling {@link ToolRegistry.define} with the same name
 * after construction.
 *
 * @example
 * ```typescript
 * const registry = registryFromMcpTools(mcpServer.listTools());
 * // Override the handler for a specific tool:
 * registry.define(
 *   { name: 'read_file', description: '...', input_schema: { ... } },
 *   (inp) => mcpServer.callTool('read_file', inp)
 * );
 * ```
 */
export function registryFromMcpTools(tools: McpTool[]): ToolRegistry {
  return ToolRegistry.fromMcpTools(tools);
}
