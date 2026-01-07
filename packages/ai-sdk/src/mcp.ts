import { jsonSchema, type ToolSet } from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';
import type { experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import type { ListToolResult } from './activities';

export type McpClientFactory = (args: unknown) => Promise<MCPClient>;
export type McpClientFactories = { [serviceName: string]: McpClientFactory };

/**
 * Options for the Temporal MCP Client
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export interface TemporalMCPClientOptions {
  readonly name: string;
  readonly clientArgs?: unknown;
  readonly activityOptions?: ActivityOptions;
}

/**
 * A Temporal MCP Client which uses activities to execute list tools and call tools.
 * This should match by name an MCPClientFactory registered with the AI SDK plugin to function.
 *
 * This is intentionally similar to the AI SDK's ``MCPClient``, but is lacking functions not used by the framework.
 * It doesn't close either since the underlying clients are created in activities.
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export class TemporalMCPClient {
  constructor(readonly options: TemporalMCPClientOptions) {}

  async tools(): Promise<ToolSet> {
    const activities = workflow.proxyActivities({
      startToCloseTimeout: '10 minutes',
      ...this.options.activityOptions,
    });

    const listActivity = activities[this.options.name + '-listTools'];
    const tools: Record<string, ListToolResult> = await listActivity!({ clientArgs: this.options.clientArgs });
    return Object.fromEntries(
      Object.entries(tools).map(([toolName, toolResult]) => [
        toolName,
        {
          execute: async (input, options) => {
            const activities = workflow.proxyActivities({
              summary: toolName,
              startToCloseTimeout: '10 minutes',
              ...this.options,
            });
            const callActivity = activities[this.options.name + '-callTool']!;
            return await callActivity({ name: toolName, input, options, clientArgs: this.options.clientArgs });
          },
          inputSchema: jsonSchema(toolResult.inputSchema as JSONSchema7),
          type: 'dynamic',
        },
      ])
    );
  }
}
