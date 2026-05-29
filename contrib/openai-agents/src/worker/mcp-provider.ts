import {
  MCP_CALL_TOOL_SUFFIX,
  MCP_GET_PROMPT_SUFFIX,
  MCP_LIST_PROMPTS_SUFFIX,
  MCP_LIST_TOOLS_SUFFIX,
  type StatelessMCPServerFactory,
} from '../common/mcp-types';

export class StatelessMCPServerProvider {
  constructor(
    public readonly name: string,
    private factory: StatelessMCPServerFactory
  ) {}

  _getActivities(): Record<string, (...args: any[]) => Promise<unknown>> {
    return {
      [`${this.name}${MCP_LIST_TOOLS_SUFFIX}`]: (input: unknown) => this.factory.listTools(input),
      [`${this.name}${MCP_CALL_TOOL_SUFFIX}`]: (input: any) => this.factory.callTool(input),
      [`${this.name}${MCP_LIST_PROMPTS_SUFFIX}`]: (input: unknown) => this.factory.listPrompts(input),
      [`${this.name}${MCP_GET_PROMPT_SUFFIX}`]: (input: any) => this.factory.getPrompt(input),
    };
  }
}
