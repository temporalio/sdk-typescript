import { McpClient } from '@strands-agents/sdk';
import type { JSONSchema, JSONValue } from '@strands-agents/sdk';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { activityInfo, Context as ActivityContext } from '@temporalio/activity';

/** Tool descriptor returned by the per-server `{server}-listTools` activity. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: JSONSchema;
}

/** Activity input for the per-server `{server}-callTool` activity. */
export interface CallToolInput {
  toolName: string;
  args: JSONValue;
}

const STUB_TRANSPORT: Transport = {
  async start() {
    // No-op; TemporalMCPClient never connects from inside a workflow.
  },
  async send() {
    // No-op.
  },
  async close() {
    // No-op.
  },
};

/**
 * Options for {@link TemporalMCPClient}.
 *
 * The {@link ActivityOptions} apply to every per-tool activity invocation
 * the agent makes for this MCP server.
 */
export interface TemporalMCPClientOptions {
  server: string;
  activityOptions?: ActivityOptions;
}

/**
 * Workflow-side handle to an MCP server registered on the worker.
 *
 * The transport factory and tool discovery live worker-side via
 * `StrandsPlugin({ mcpClients: { server: () => new McpClient(...) } })`.
 * This handle only carries the server name (which selects the registered
 * factory) and the per-call activity options.
 *
 * Extends {@link McpClient} so it can be passed directly in an
 * {@link AgentConfig.tools | Agent.tools} array (Strands' `flattenTools`
 * dispatches on `instanceof McpClient`). `connect()` and `disconnect()`
 * are no-ops; `listTools()` returns lightweight {@link TemporalMCPTool}
 * wrappers whose `stream()` dispatches to the per-server `{server}-callTool`
 * activity registered by {@link StrandsPlugin}.
 */
export class TemporalMCPClient extends McpClient {
  private readonly server: string;
  private readonly activityOptions: ActivityOptions;

  constructor(options: TemporalMCPClientOptions) {
    super({ transport: STUB_TRANSPORT });
    this.server = options.server;
    this.activityOptions = options.activityOptions ?? {};
  }

  override async connect(): Promise<void> {
    // No-op; all I/O happens inside the per-server callTool activity.
  }

  override async disconnect(): Promise<void> {
    // No-op.
  }

  // The base `McpClient.listTools` returns `Promise<McpTool[]>`, but `McpTool`
  // isn't re-exported from `@strands-agents/sdk`'s public index. The cast to
  // `never[]` keeps the override compatible; the agent only uses
  // `name`/`toolSpec`/`stream` on each tool, all of which
  // {@link TemporalMCPTool} provides.
  override async listTools(): Promise<never[]> {
    // Imported lazily to avoid a circular module cycle with TemporalMCPTool.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TemporalMCPTool } = require('./temporal-mcp-tool') as typeof import('./temporal-mcp-tool');
    const activities = workflow.proxyActivities<{
      [key: string]: (args: { server: string }) => Promise<McpToolInfo[]>;
    }>({
      startToCloseTimeout: '10 minutes',
      ...this.activityOptions,
    });
    const infos = await activities[listToolsActivityName(this.server)]!({ server: this.server });
    return infos.map((info) => new TemporalMCPTool(this.server, info, this.activityOptions)) as never[];
  }
}

export function listToolsActivityName(server: string): string {
  return `${server}-listTools`;
}

export function callToolActivityName(server: string): string {
  return `${server}-callTool`;
}

/**
 * Builds the per-server `{server}-listTools` activity. Enumerates the server's
 * tools live over the shared worker-process connection on every call, so the
 * agent sees the server's current tools even if it is redeployed mid-workflow.
 * Runs whenever a workflow calls {@link TemporalMCPClient.listTools}.
 */
export function buildListToolsActivity(
  server: string,
  factory: () => McpClient,
  idleMs: number = MCP_CONNECTION_IDLE_MS
): (input: { server: string }) => Promise<McpToolInfo[]> {
  const name = listToolsActivityName(server);
  const fn = async (_input: { server: string }): Promise<McpToolInfo[]> => {
    const client = await getConnection(server, factory, idleMs);
    try {
      const tools = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.toolSpec.inputSchema,
      }));
    } catch (err) {
      // The session may be broken (e.g. the server was redeployed); drop it so
      // the next call reconnects to the current deployment.
      await _evictConnection(server);
      throw err;
    }
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

/**
 * Default for how long an idle MCP connection is kept open before it's
 * disconnected. The timer resets on every {@link callToolActivityName |
 * callTool} that reuses the connection. Override per worker via
 * `StrandsPlugin({ mcpConnectionIdleMs })`.
 */
export const MCP_CONNECTION_IDLE_MS = 5 * 60 * 1000;

// Worker-process caches, keyed by server name. Activities run in the worker's
// Node process, so this module state is shared across every activity invocation on the worker.
const CONNECTIONS: Map<string, Promise<McpClient>> = new Map();
const IDLE_TIMERS: Map<string, NodeJS.Timeout> = new Map();

function resetIdleTimer(server: string, idleMs: number): void {
  const existing = IDLE_TIMERS.get(server);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => void _evictConnection(server), idleMs);
  // Don't let an idle MCP connection keep the worker process alive.
  timer.unref?.();
  IDLE_TIMERS.set(server, timer);
}

export async function _evictConnection(server: string): Promise<void> {
  const timer = IDLE_TIMERS.get(server);
  if (timer !== undefined) {
    clearTimeout(timer);
    IDLE_TIMERS.delete(server);
  }
  const entry = CONNECTIONS.get(server);
  if (entry === undefined) return;
  CONNECTIONS.delete(server);
  try {
    const client = await entry;
    await client.disconnect();
  } catch {
    // Best-effort; the session may already be broken.
  }
}

function getConnection(server: string, factory: () => McpClient, idleMs: number): Promise<McpClient> {
  let entry = CONNECTIONS.get(server);
  if (entry === undefined) {
    entry = (async () => {
      const client = factory();
      await client.connect();
      return client;
    })();
    CONNECTIONS.set(server, entry);
    // If the connect handshake fails, drop the rejected promise so the next
    // call retries instead of caching the failure forever.
    entry.catch(() => {
      if (CONNECTIONS.get(server) === entry) CONNECTIONS.delete(server);
    });
  }
  resetIdleTimer(server, idleMs);
  return entry;
}

/**
 * Builds the per-server `{server}-callTool` activity. Reuses a worker-process
 * MCP session opened lazily through the user-supplied factory — successive
 * calls share one connection rather than reconnecting per call. Idle
 * connections are disconnected after `idleMs` (defaults to
 * {@link MCP_CONNECTION_IDLE_MS}).
 */
export function buildCallToolActivity(
  server: string,
  factory: () => McpClient,
  idleMs: number = MCP_CONNECTION_IDLE_MS
): (input: CallToolInput) => Promise<JSONValue> {
  const name = callToolActivityName(server);
  const fn = async (input: CallToolInput): Promise<JSONValue> => {
    ActivityContext.current().log.debug(`Calling MCP tool ${input.toolName} on server ${server}`, {
      activityId: activityInfo().activityId,
    });
    const client = await getConnection(server, factory, idleMs);
    // Dispatch by name without re-listing tools on the connection: the agent
    // already has the schema from `listTools`, and `McpClient.callTool` only
    // reads `tool.name` to build the request. A minimal `{ name }` matches the
    // by-name dispatch the Python SDK does via `session.call_tool`.
    const tool = { name: input.toolName } as unknown as Parameters<McpClient['callTool']>[0];
    try {
      return await client.callTool(tool, input.args);
    } catch (err) {
      // The session may be broken; drop it so the next call reconnects.
      await _evictConnection(server);
      throw err;
    }
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}
