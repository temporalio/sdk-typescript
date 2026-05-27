import { McpClient } from '@strands-agents/sdk';
import type { JSONValue } from '@strands-agents/sdk';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { activityInfo, Context as ActivityContext } from '@temporalio/activity';

/** Cached tool descriptor; one per MCP tool, populated at worker startup. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Activity input for the per-server `{server}-callTool` activity. */
export interface CallToolInput {
  toolName: string;
  args: JSONValue;
}

const TOOL_CACHE: Record<string, McpToolInfo[]> = {};

/** @internal */
export function _populateCache(server: string, infos: McpToolInfo[]): void {
  TOOL_CACHE[server] = infos;
}

/** @internal */
export function _clearCache(server: string): void {
  delete TOOL_CACHE[server];
}

/** @internal */
export function _readCache(server: string): McpToolInfo[] {
  return TOOL_CACHE[server] ?? [];
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
 * Builds the per-server `{server}-listTools` activity. Returns the tool list
 * cached at worker startup; runs on every workflow that calls
 * {@link TemporalMCPClient.listTools}.
 */
export function buildListToolsActivity(server: string): (input: { server: string }) => Promise<McpToolInfo[]> {
  const name = listToolsActivityName(server);
  const fn = async (_input: { server: string }): Promise<McpToolInfo[]> => {
    return _readCache(server);
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

/**
 * Builds the per-server `{server}-callTool` activity. Opens an MCP session
 * through the user-supplied factory, invokes the named tool, and returns
 * the raw result for the workflow to forward as a Strands tool result.
 */
export function buildCallToolActivity(
  server: string,
  factory: () => McpClient
): (input: CallToolInput) => Promise<JSONValue> {
  const name = callToolActivityName(server);
  const fn = async (input: CallToolInput): Promise<JSONValue> => {
    ActivityContext.current().log.debug(`Calling MCP tool ${input.toolName} on server ${server}`, {
      activityId: activityInfo().activityId,
    });
    const client = factory();
    try {
      await client.connect();
      const tools = await client.listTools();
      const tool = tools.find((t) => t.name === input.toolName);
      if (tool === undefined) {
        throw new Error(`MCP tool '${input.toolName}' not found on server '${server}'`);
      }
      return await client.callTool(tool, input.args);
    } finally {
      await client.disconnect();
    }
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

/**
 * Called at worker startup (via the plugin's `runContext`) to connect to the
 * MCP server, list its tools, and stash the descriptors in the worker-process
 * cache. The `{server}-listTools` activity reads from this cache.
 */
export async function populateMcpCache(server: string, factory: () => McpClient): Promise<void> {
  const client = factory();
  try {
    await client.connect();
    const tools = await client.listTools();
    _populateCache(
      server,
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.toolSpec.inputSchema,
      }))
    );
  } finally {
    await client.disconnect();
  }
}
