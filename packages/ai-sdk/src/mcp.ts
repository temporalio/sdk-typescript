import type { ToolSet } from 'ai';
import type { experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import type { ListToolResult } from './activities';

export type McpClientFactory = (args: unknown) => Promise<MCPClient>;

/**
 * Options for the Temporal MCP Client
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export interface TemporalMCPClientOptions {
  readonly name: string;
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  readonly clientArgs?: any;
  readonly activityOptions?: ActivityOptions;
}

/**
 * A Temporal MCP Client which uses activities to execute list tools and call tools.
 * This should match by name an MCPClientFactory registered with the AI SDK plugin to function.
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export class TemporalMCPClient {
  constructor(readonly options: TemporalMCPClientOptions) {}

  async tools(): Promise<ToolSet> {
    workflow.log.info(`Options: ${this.options.activityOptions}`);
    const tools: Record<string, ListToolResult> = await workflow
      .proxyActivities({ startToCloseTimeout: '10 minutes', ...this.options.activityOptions })
      [this.options.name + '-listTools']({ clientArgs: this.options.clientArgs });
    return Object.fromEntries(
      Object.entries(tools).map(([toolName, toolResult]) => [
        toolName,
        {
          execute: async (args: any, options) =>
            await workflow
              .proxyActivities({
                summary: toolName,
                startToCloseTimeout: '10 minutes',
                ...this.options,
              })
              [this.options.name + '-callTool']({ name: toolName, args, options, clientArgs: this.options.clientArgs }),
          inputSchema: {
            ...toolResult.inputSchema,
            _type: undefined,
            validate: undefined,
            [Symbol.for('vercel.ai.schema')]: true,
            [Symbol.for('vercel.ai.validator')]: true,
          },
          type: 'dynamic',
        },
      ])
    );
  }
}
