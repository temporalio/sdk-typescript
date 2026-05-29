import { ApplicationFailure } from '@temporalio/common';
import { Context, activityInfo } from '@temporalio/activity';
import type { NativeConnection } from '@temporalio/worker';
import {
  MCP_CALL_TOOL_SUFFIX,
  MCP_GET_PROMPT_SUFFIX,
  MCP_LIST_PROMPTS_SUFFIX,
  MCP_LIST_TOOLS_SUFFIX,
  MCP_SERVER_SESSION_SUFFIX,
  MCP_STATEFUL_SUFFIX,
  type MCPCallToolResult,
  type MCPPromptDefinition,
  type MCPToolDefinition,
  type StatefulMCPServer,
  type StatefulMcpServerSessionArgs,
} from '../common/mcp-types';
import { startAdaptiveHeartbeat } from './heartbeat';

export function registerCancelShutdown(ctx: Context, dedicatedWorker: { shutdown: () => void }): void {
  ctx.cancelled.catch(() => {
    dedicatedWorker.shutdown();
  });
}

interface CallToolArgs {
  toolName: string;
  args: Record<string, unknown> | null;
}

interface GetPromptArgs {
  name: string;
  arguments: Record<string, unknown> | null;
}

/**
 * Stateful MCP server provider. Maintains a persistent MCP connection per
 * Workflow run via a dedicated in-process Worker on a per-run Task Queue.
 *
 * Callers must handle `ApplicationFailure` with type `"DedicatedWorkerFailure"`
 * if the dedicated Worker fails to start or misses a heartbeat.
 */
export class StatefulMCPServerProvider {
  private readonly _name: string;
  private readonly _servers: Map<string, StatefulMCPServer> = new Map();
  private readonly _serverFactory: (factoryArgument: unknown | undefined) => StatefulMCPServer;
  private readonly _nativeConnection: NativeConnection;

  /**
   * @param name - The internal name is `${name}-stateful` to avoid colliding with stateless providers using the same base name.
   * @param serverFactory - Must return a fresh server instance per call (one per Workflow run).
   * @param nativeConnection - NativeConnection used by the dedicated per-run Worker; typically the same one the main Worker uses.
   */
  constructor(
    name: string,
    serverFactory: (factoryArgument: unknown | undefined) => StatefulMCPServer,
    nativeConnection: NativeConnection
  ) {
    this._name = `${name}${MCP_STATEFUL_SUFFIX}`;
    this._serverFactory = serverFactory;
    this._nativeConnection = nativeConnection;
  }

  get name(): string {
    return this._name;
  }

  _getActivities(): Record<string, (...args: any[]) => Promise<unknown>> {
    const serverId = (): string => {
      const info = activityInfo();
      // `workflowExecution` is always set for Activities scheduled from a Workflow,
      // which is the only way these per-Run Activities are dispatched.
      return `${this._name}@${info.workflowExecution!.runId}`;
    };

    const getServerOrThrow = (): StatefulMCPServer => {
      const id = serverId();
      const server = this._servers.get(id);
      if (!server) {
        throw ApplicationFailure.create({
          message: `No active server for ${id}`,
          type: 'StatefulMCPServerNotFound',
          nonRetryable: true,
        });
      }
      return server;
    };

    // Operation Activities — registered on the per-run Task Queue.
    const listTools = async (): Promise<MCPToolDefinition[]> => getServerOrThrow().listTools();

    const callTool = async (input: CallToolArgs): Promise<MCPCallToolResult[]> =>
      getServerOrThrow().callTool(input.toolName, input.args);

    const listPrompts = async (): Promise<MCPPromptDefinition[]> => getServerOrThrow().listPrompts?.() ?? [];

    const getPrompt = async (input: GetPromptArgs): Promise<unknown> =>
      getServerOrThrow().getPrompt?.(input.name, input.arguments) ?? null;

    // Long-running session Activity on the MAIN Worker's Task Queue. Creates
    // a server, connects it, spins up a dedicated per-run Worker, then awaits
    // until cancelled.
    const serverSession = async (input?: StatefulMcpServerSessionArgs): Promise<void> => {
      const info = activityInfo();
      const sid = `${this._name}@${info.workflowExecution!.runId}`;

      // Heartbeats so a slow `server.connect()` doesn't trip the timeout.
      const stopHeartbeat = startAdaptiveHeartbeat();

      try {
        if (this._servers.has(sid)) {
          throw ApplicationFailure.create({
            message:
              'Cannot connect to an already running server. Use a distinct name if running multiple servers in one workflow.',
            type: 'StatefulMCPServerAlreadyRunning',
            nonRetryable: true,
          });
        }

        const server = this._serverFactory(input?.factoryArgument);

        try {
          this._servers.set(sid, server);
          await server.connect();

          const { Worker } = await import('@temporalio/worker');

          const dedicatedTaskQueue = sid;

          const dedicatedActivities: Record<string, (...args: any[]) => Promise<unknown>> = {
            [`${this._name}${MCP_LIST_TOOLS_SUFFIX}`]: listTools,
            [`${this._name}${MCP_CALL_TOOL_SUFFIX}`]: callTool,
            [`${this._name}${MCP_LIST_PROMPTS_SUFFIX}`]: listPrompts,
            [`${this._name}${MCP_GET_PROMPT_SUFFIX}`]: getPrompt,
          };

          // Wire the Activity interceptor identically to the main Worker so
          // tool/prompt Activities still restore trace context and emit
          // `temporal:executeActivity:*` spans. Options are forwarded per-run
          // via input. Lazy import to avoid pulling the Worker package
          // unnecessarily.
          const { OpenAIAgentsTraceActivityInboundInterceptor } = await import('./trace-interceptor');
          const interceptorOpts = input?.activityInterceptorOptions;
          const dedicatedWorker = await Worker.create({
            connection: this._nativeConnection,
            taskQueue: dedicatedTaskQueue,
            activities: dedicatedActivities,
            maxConcurrentActivityTaskExecutions: 1,
            interceptors: {
              activity: [
                (ctx) => ({
                  inbound: new OpenAIAgentsTraceActivityInboundInterceptor(ctx, interceptorOpts),
                }),
              ],
            },
          });

          registerCancelShutdown(Context.current(), dedicatedWorker);

          await dedicatedWorker.run();
        } finally {
          await server.cleanup();
          this._servers.delete(sid);
        }
      } finally {
        stopHeartbeat();
      }
    };

    // Only the session Activity is registered on the main Worker; the
    // operation Activities live on the per-run Worker.
    return {
      [`${this._name}${MCP_SERVER_SESSION_SUFFIX}`]: serverSession,
    };
  }
}
