import type { MCPServer } from '@openai/agents-core';
import type { Duration, RetryPolicy } from '@temporalio/common';
import { proxyActivities } from '@temporalio/workflow';

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

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface MCPCallToolResult {
  type: string;
  text: string;
}

export interface TemporalMCPServer extends MCPServer {
  listPrompts(factoryArgument?: unknown): Promise<MCPPromptDefinition[]>;
  getPrompt(promptName: string, args?: Record<string, unknown> | null, factoryArgument?: unknown): Promise<unknown>;
}

export interface StatelessMcpServerOptions {
  cacheToolsList?: boolean;
  startToCloseTimeout?: Duration;
  heartbeatTimeout?: Duration;
  taskQueue?: string;
  retryPolicy?: RetryPolicy;
  factoryArgument?: unknown;
}

export function statelessMcpServer(name: string, options?: StatelessMcpServerOptions): TemporalMCPServer {
  const activities = proxyActivities<Record<string, (...args: any[]) => Promise<any>>>({
    startToCloseTimeout: options?.startToCloseTimeout ?? '1 minute',
    heartbeatTimeout: options?.heartbeatTimeout,
    taskQueue: options?.taskQueue,
    retry: options?.retryPolicy,
  });

  const listToolsActivityName = `${name}-list-tools`;
  const callToolActivityName = `${name}-call-tool-v2`;
  const listPromptsActivityName = `${name}-list-prompts`;
  const getPromptActivityName = `${name}-get-prompt-v2`;

  let cachedTools: any[] | undefined;
  const shouldCache = options?.cacheToolsList ?? true;
  const factoryArg = options?.factoryArgument;

  return {
    cacheToolsList: shouldCache,
    get name() {
      return name;
    },
    async connect() {
      // No-op — connections are managed in activities
    },
    async close() {
      // No-op
    },
    async listTools() {
      if (shouldCache && cachedTools) {
        return cachedTools;
      }
      const listToolsFn = activities[listToolsActivityName];
      if (!listToolsFn) throw new Error(`Activity '${listToolsActivityName}' not found`);
      const tools = await listToolsFn(factoryArg !== undefined ? { factoryArgument: factoryArg } : undefined);
      if (shouldCache) {
        cachedTools = tools;
      }
      return tools;
    },
    async callTool(toolName: string, args: Record<string, unknown> | null) {
      const callToolFn = activities[callToolActivityName];
      if (!callToolFn) throw new Error(`Activity '${callToolActivityName}' not found`);
      return callToolFn({ toolName, args, ...(factoryArg !== undefined ? { factoryArgument: factoryArg } : {}) });
    },
    async listPrompts(overrideFactoryArg?: unknown) {
      const listPromptsFn = activities[listPromptsActivityName];
      if (!listPromptsFn) throw new Error(`Activity '${listPromptsActivityName}' not found`);
      const fa = overrideFactoryArg ?? factoryArg;
      return listPromptsFn(fa !== undefined ? { factoryArgument: fa } : undefined);
    },
    async getPrompt(promptName: string, args?: Record<string, unknown> | null, overrideFactoryArg?: unknown) {
      const getPromptFn = activities[getPromptActivityName];
      if (!getPromptFn) throw new Error(`Activity '${getPromptActivityName}' not found`);
      const fa = overrideFactoryArg ?? factoryArg;
      return getPromptFn({
        promptName,
        promptArguments: args ?? null,
        ...(fa !== undefined ? { factoryArgument: fa } : {}),
      });
    },
    async invalidateToolsCache() {
      cachedTools = undefined;
    },
  };
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
