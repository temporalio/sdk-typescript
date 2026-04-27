import type { MCPPromptDefinition } from '../workflow/mcp-client';

export type { MCPPromptDefinition } from '../workflow/mcp-client';

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

export class StatelessMCPServerProvider {
  constructor(
    public readonly name: string,
    private factory: StatelessMCPServerFactory
  ) {}

  _getActivities(): Record<string, (...args: any[]) => Promise<unknown>> {
    const callTool = (input: any) => this.factory.callTool(input);
    const getPrompt = (input: any) => this.factory.getPrompt(input);
    return {
      [`${this.name}-list-tools`]: (input: unknown) => this.factory.listTools(input),
      [`${this.name}-call-tool-v2`]: callTool,
      [`${this.name}-list-prompts`]: (input: unknown) => this.factory.listPrompts(input),
      [`${this.name}-get-prompt-v2`]: getPrompt,
      // Deprecated: use call-tool-v2 instead (JSDoc on computed keys doesn't render in IDEs)
      [`${this.name}-call-tool`]: callTool,
      // Deprecated: use get-prompt-v2 instead
      [`${this.name}-get-prompt`]: getPrompt,
    };
  }
}
