import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
  TimeoutType,
  type ActivityOptions,
  type Duration,
  type RetryPolicy,
} from '@temporalio/common';
import { CancellationScope, isCancellation, scheduleActivity, workflowInfo } from '@temporalio/workflow';
import {
  DEDICATED_WORKER_FAILURE_TYPE,
  MCP_CALL_TOOL_SUFFIX,
  MCP_GET_PROMPT_SUFFIX,
  MCP_LIST_PROMPTS_SUFFIX,
  MCP_LIST_TOOLS_SUFFIX,
  MCP_SERVER_SESSION_SUFFIX,
  MCP_STATEFUL_SUFFIX,
  type MCPPromptDefinition,
  type StatefulMcpServerSessionArgs,
  type StatefulTemporalMCPServer,
} from '../common/mcp-types';
import { getCurrentPluginConfig } from './plugin-config-store';

export interface StatefulMcpServerOptions {
  /** Activity options for tool/prompt operation Activities on the dedicated Worker. */
  config?: {
    startToCloseTimeout?: Duration;
    scheduleToStartTimeout?: Duration;
    heartbeatTimeout?: Duration;
    taskQueue?: string;
    retryPolicy?: RetryPolicy;
  };
  /** Activity options for the long-running server-session Activity. */
  serverSessionConfig?: {
    startToCloseTimeout?: Duration;
    heartbeatTimeout?: Duration;
  };
  factoryArgument?: unknown;
  /**
   * When `true` (the default), the agent SDK caches `listTools` for the
   * agent's lifetime. Set to `false` if the server's tool set may change
   * mid-run.
   */
  cacheToolsList?: boolean;
}

const DEDICATED_WORKER_SCHEDULE_FAILURE_MESSAGE =
  'MCP Stateful Server Worker failed to schedule activity. Check that a worker is polling the dedicated task queue for this MCP run.';

const DEDICATED_WORKER_HEARTBEAT_FAILURE_MESSAGE =
  'MCP Stateful Server Worker failed to heartbeat. Check that a worker is polling the dedicated task queue for this MCP run.';

async function handleWorkerFailure<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (err instanceof ActivityFailure && err.cause instanceof TimeoutFailure) {
      if (err.cause.timeoutType === TimeoutType.SCHEDULE_TO_START) {
        throw ApplicationFailure.create({
          message: DEDICATED_WORKER_SCHEDULE_FAILURE_MESSAGE,
          type: DEDICATED_WORKER_FAILURE_TYPE,
          nonRetryable: false,
        });
      }
      if (err.cause.timeoutType === TimeoutType.HEARTBEAT) {
        throw ApplicationFailure.create({
          message: DEDICATED_WORKER_HEARTBEAT_FAILURE_MESSAGE,
          type: DEDICATED_WORKER_FAILURE_TYPE,
          nonRetryable: false,
        });
      }
    }
    throw err;
  }
}

/**
 * Workflow-side handle for a stateful MCP server connection. Tool and prompt
 * operations route to a dedicated in-process Worker on a per-run Task Queue,
 * preserving server state across calls.
 */
export class StatefulMCPServerReference implements StatefulTemporalMCPServer {
  private readonly _name: string;
  private readonly _operationConfig: ActivityOptions;
  private readonly _sessionConfig: ActivityOptions;
  private readonly _factoryArgument: unknown;
  private readonly _cacheToolsList: boolean;
  private _sessionScope: CancellationScope | undefined;
  private _sessionPromise: Promise<void> | undefined;
  private _connected = false;

  constructor(name: string, options?: StatefulMcpServerOptions) {
    this._name = `${name}${MCP_STATEFUL_SUFFIX}`;
    this._operationConfig = {
      startToCloseTimeout: options?.config?.startToCloseTimeout ?? '1 minute',
      scheduleToStartTimeout: options?.config?.scheduleToStartTimeout ?? '30 seconds',
      heartbeatTimeout: options?.config?.heartbeatTimeout,
      taskQueue: options?.config?.taskQueue,
      retry: options?.config?.retryPolicy,
    };
    this._sessionConfig = {
      startToCloseTimeout: options?.serverSessionConfig?.startToCloseTimeout ?? '1 hour',
      heartbeatTimeout: options?.serverSessionConfig?.heartbeatTimeout,
    };
    this._factoryArgument = options?.factoryArgument;
    this._cacheToolsList = options?.cacheToolsList ?? true;
  }

  get name(): string {
    return this._name;
  }

  get cacheToolsList(): boolean {
    return this._cacheToolsList;
  }

  /** Starts the per-run server-session Activity. */
  async connect(): Promise<void> {
    const runId = workflowInfo().runId;
    this._operationConfig.taskQueue = `${this._name}@${runId}`;

    const sessionActivityName = `${this._name}${MCP_SERVER_SESSION_SUFFIX}`;

    // Forward this Workflow's trace-interceptor settings to the session
    // Activity so the dedicated per-run Worker wires its Activity interceptor
    // identically — otherwise tool/prompt Activities would skip trace-context
    // restoration and the `temporal:executeActivity:*` span.
    const pluginConfig = getCurrentPluginConfig();
    const args: StatefulMcpServerSessionArgs = {
      factoryArgument: this._factoryArgument,
      activityInterceptorOptions: pluginConfig ? { addTemporalSpans: pluginConfig.addTemporalSpans } : undefined,
    };

    this._sessionScope = new CancellationScope();
    this._sessionPromise = this._sessionScope.run(() =>
      scheduleActivity<void>(sessionActivityName, [args], this._sessionConfig)
    );
    // Errors are observed during cleanup, not here.
    this._sessionPromise.catch(() => {});
    this._connected = true;
  }

  /** Cancels the server-session Activity, tearing down the dedicated Worker. */
  async cleanup(): Promise<void> {
    if (this._sessionScope) {
      this._sessionScope.cancel();
      try {
        await this._sessionPromise;
      } catch (err: unknown) {
        if (!isCancellation(err)) {
          throw err;
        }
      }
      this._sessionScope = undefined;
      this._sessionPromise = undefined;
      this._connected = false;
    }
  }

  /** Alias for `cleanup()` — matches the MCPServer interface. */
  async close(): Promise<void> {
    await this.cleanup();
  }

  private assertConnected(): void {
    if (!this._connected) {
      throw ApplicationFailure.create({
        message: 'Stateful MCP Server not connected — did you forget to call `connect()` before using the server?',
      });
    }
  }

  async listTools(): Promise<any[]> {
    this.assertConnected();
    return handleWorkerFailure(() => scheduleActivity(this._name + MCP_LIST_TOOLS_SUFFIX, [], this._operationConfig));
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    this.assertConnected();
    return handleWorkerFailure(() =>
      scheduleActivity(this._name + MCP_CALL_TOOL_SUFFIX, [{ toolName, args }], this._operationConfig)
    );
  }

  async listPrompts(): Promise<MCPPromptDefinition[]> {
    this.assertConnected();
    return handleWorkerFailure(() => scheduleActivity(this._name + MCP_LIST_PROMPTS_SUFFIX, [], this._operationConfig));
  }

  async getPrompt(promptName: string, args?: Record<string, unknown> | null): Promise<unknown> {
    this.assertConnected();
    return handleWorkerFailure(() =>
      scheduleActivity(
        this._name + MCP_GET_PROMPT_SUFFIX,
        [{ name: promptName, arguments: args ?? null }],
        this._operationConfig
      )
    );
  }

  async invalidateToolsCache(): Promise<void> {
    // Caching is owned by the upstream agent SDK; nothing to invalidate on the
    // Workflow-side handle.
  }
}

/**
 * Creates a stateful MCP server handle. Maintains a persistent MCP connection
 * across the Workflow via a dedicated per-run Worker.
 *
 * If the dedicated Worker fails (startup timeout or missed heartbeat),
 * operations throw `ApplicationFailure` with type `"DedicatedWorkerFailure"`.
 *
 * @param name - Server name; must match the `StatefulMCPServerProvider` registered on the Worker side.
 */
export function statefulMcpServer(name: string, options?: StatefulMcpServerOptions): StatefulTemporalMCPServer {
  return new StatefulMCPServerReference(name, options);
}
