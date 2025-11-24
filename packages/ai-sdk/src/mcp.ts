import type { ToolSet } from 'ai';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import type { ListToolResult } from './activities';

export class TemporalMCPClient {
  constructor(
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    readonly clientArgs?: any,
    readonly options?: ActivityOptions
  ) {}

  async tools(): Promise<ToolSet> {
    const tools: Record<string, ListToolResult> = await workflow
      .proxyActivities(this.options ?? { startToCloseTimeout: '10 minutes' })
      .listTools({ clientArgs: this.clientArgs });
    return Object.fromEntries(
      Object.entries(tools).map(([toolName, toolResult]) => [
        toolName,
        {
          execute: async (args: any, options) =>
            await workflow
              .proxyActivities({
                summary: toolName,
                ...(this.options ?? { startToCloseTimeout: '10 minutes' }),
              })
              .callTool({ name: toolName, args, options, clientArgs: this.clientArgs }),
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
