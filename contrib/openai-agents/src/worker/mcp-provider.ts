import type { MCPServer } from '@openai/agents-core';
import { MCP_CALL_TOOL_SUFFIX, MCP_LIST_TOOLS_SUFFIX, MCP_STATELESS_SUFFIX } from '../common/mcp-types';

export class StatelessMCPServerProvider {
  private readonly _name: string;

  constructor(
    public readonly name: string,
    private serverFactory: (factoryArgument?: unknown) => MCPServer
  ) {
    this._name = `${name}${MCP_STATELESS_SUFFIX}`;
  }

  _getActivities(): Record<string, (...args: any[]) => Promise<unknown>> {
    return {
      [`${this._name}${MCP_LIST_TOOLS_SUFFIX}`]: async (input?: { factoryArgument?: unknown }) => {
        const s = this.serverFactory(input?.factoryArgument);
        try {
          await s.connect();
          return await s.listTools();
        } finally {
          await s.close();
        }
      },
      [`${this._name}${MCP_CALL_TOOL_SUFFIX}`]: async (input: {
        toolName: string;
        args: Record<string, unknown> | null;
        factoryArgument?: unknown;
      }) => {
        const s = this.serverFactory(input.factoryArgument);
        try {
          await s.connect();
          return await s.callTool(input.toolName, input.args);
        } finally {
          await s.close();
        }
      },
    };
  }
}
