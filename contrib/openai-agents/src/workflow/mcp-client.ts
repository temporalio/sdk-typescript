import type { MCPServer } from '@openai/agents-core';
import type { Duration, RetryPolicy } from '@temporalio/common';
import { proxyActivities } from '@temporalio/workflow';
import { MCP_CALL_TOOL_SUFFIX, MCP_LIST_TOOLS_SUFFIX, MCP_STATELESS_SUFFIX } from '../common/mcp-types';

export interface StatelessMcpServerOptions {
  cacheToolsList?: boolean;
  startToCloseTimeout?: Duration;
  heartbeatTimeout?: Duration;
  taskQueue?: string;
  retryPolicy?: RetryPolicy;
  factoryArgument?: unknown;
}

export function statelessMcpServer(name: string, options?: StatelessMcpServerOptions): MCPServer {
  const activities = proxyActivities<Record<string, (...args: any[]) => Promise<any>>>({
    startToCloseTimeout: options?.startToCloseTimeout ?? '1 minute',
    heartbeatTimeout: options?.heartbeatTimeout,
    taskQueue: options?.taskQueue,
    retry: options?.retryPolicy,
  });

  const internalName = `${name}${MCP_STATELESS_SUFFIX}`;
  const listToolsActivityName = `${internalName}${MCP_LIST_TOOLS_SUFFIX}`;
  const callToolActivityName = `${internalName}${MCP_CALL_TOOL_SUFFIX}`;

  let cachedTools: any[] | undefined;
  const shouldCache = options?.cacheToolsList ?? true;
  const factoryArg = options?.factoryArgument;

  return {
    cacheToolsList: shouldCache,
    get name() {
      return name;
    },
    async connect() {
      // No-op — connections are managed in Activities
    },
    async close() {},
    async listTools() {
      if (shouldCache && cachedTools) {
        return cachedTools;
      }
      const tools = await activities[listToolsActivityName]!(
        factoryArg !== undefined ? { factoryArgument: factoryArg } : undefined
      );
      if (shouldCache) {
        cachedTools = tools;
      }
      return tools;
    },
    async callTool(toolName: string, args: Record<string, unknown> | null) {
      return activities[callToolActivityName]!({
        toolName,
        args,
        ...(factoryArg !== undefined ? { factoryArgument: factoryArg } : {}),
      });
    },
    async invalidateToolsCache() {
      cachedTools = undefined;
    },
  };
}
