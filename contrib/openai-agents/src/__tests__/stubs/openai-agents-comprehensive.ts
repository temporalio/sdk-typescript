import {
  withCustomSpan,
  type MCPServer,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents-core';
import { APIError } from 'openai';
import * as nexus from 'nexus-rpc';
import { compNexusService } from '../workflows/openai-agents-comprehensive';
import { textResponse } from './openai-agents-fakes';

const ZIP_TO_CITY: Record<string, string> = {
  '10001': 'New York',
  '94016': 'San Francisco',
};

/** Emits `getCity_handler` to verify trace context propagates from the Workflow side into the Nexus Operation handler. */
export const compNexusServiceHandler = nexus.serviceHandler(compNexusService, {
  async getCity(_ctx, input) {
    return withCustomSpan(async () => ({ city: ZIP_TO_CITY[input.zip] ?? 'Unknown' }), {
      data: { name: 'getCity_handler', data: {} },
    });
  },
});

/**
 * Throws the given error on the first `failuresBeforeSuccess` calls, then
 * returns a text response with `successText` from then on. The thrown
 * value mimics the shape of an `openai.APIError` enough for the activity
 * boundary to classify it via the integration's error-mapping rules.
 */
export class RetryableThenSuccessModelProvider implements ModelProvider {
  private callsSeen = 0;
  constructor(
    public readonly failuresBeforeSuccess: number,
    public readonly successText: string,
    public readonly errorStatus = 429
  ) {}

  getModel(_name?: string): Model {
    return {
      getResponse: async (_req: ModelRequest): Promise<ModelResponse> => {
        const n = this.callsSeen++;
        if (n < this.failuresBeforeSuccess) {
          throw new APIError(this.errorStatus, undefined, 'simulated transient error', new Headers());
        }
        return textResponse(this.successText);
      },
      // eslint-disable-next-line require-yield
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        throw new Error('streaming not supported');
      },
    } as Model;
  }

  reset(): void {
    this.callsSeen = 0;
  }
}

/**
 * Always throws a synthetic error with a fixed HTTP status. Used to assert
 * non-retryable classifications (400 -> `ModelInvocationError.BadRequest`,
 * 401 -> `ModelInvocationError.Authentication`, etc.).
 */
export class ErrorModelProvider implements ModelProvider {
  constructor(public readonly status: number) {}

  getModel(_name?: string): Model {
    return {
      getResponse: async (): Promise<ModelResponse> => {
        throw new APIError(this.status, undefined, `simulated ${this.status} error`, new Headers());
      },
      // eslint-disable-next-line require-yield
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        throw new Error('streaming not supported');
      },
    } as Model;
  }
}

/**
 * A stateless MCP server factory exposing one tool: `searchDocs`. The tool
 * returns canned text per query argument. Used by Agent A in the
 * comprehensive scenario and exercised again after handoff by Agent B.
 */
export const mockStatelessMcpFactory = (_factoryArgument?: unknown): MCPServer => ({
  cacheToolsList: false,
  name: 'mockStatelessMcp',
  async connect() {},
  async close() {},
  async listTools() {
    return [
      {
        name: 'searchDocs',
        description: 'Search internal docs',
        inputSchema: {
          type: 'object' as const,
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ];
  },
  async callTool(toolName: string, args: Record<string, unknown> | null) {
    if (toolName === 'searchDocs') {
      const q = String((args ?? {}).query ?? '');
      return [{ type: 'text', text: `[stateless] result for "${q}"` }];
    }
    throw new Error(`Unknown tool: ${toolName}`);
  },
  async invalidateToolsCache() {},
});

/**
 * Stateful MCP server backed by per-instance counter. Each tool call
 * increments and includes the counter, proving the session is held across
 * calls for the lifetime of a single workflow run.
 *
 * Returned by `mockStatefulMcpFactory` (the function the
 * `StatefulMCPServerProvider` invokes once per run).
 */
class CountingStatefulMcpServer implements MCPServer {
  cacheToolsList = false;
  readonly name = 'mockStatefulMcp';
  private connected = false;
  private callCount = 0;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async listTools() {
    if (!this.connected) throw new Error('not connected');
    return [
      {
        name: 'runDbQuery',
        description: 'Run a database query (session-stateful)',
        inputSchema: {
          type: 'object' as const,
          properties: { sql: { type: 'string' } },
          required: ['sql'],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(toolName: string, args: Record<string, unknown> | null) {
    if (!this.connected) throw new Error('not connected');
    if (toolName === 'runDbQuery') {
      this.callCount++;
      const sql = String((args ?? {}).sql ?? '');
      return [{ type: 'text', text: `[stateful #${this.callCount}] ran "${sql}"` }];
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  async invalidateToolsCache(): Promise<void> {}
}

export function mockStatefulMcpFactory(_factoryArgument?: unknown): MCPServer {
  return new CountingStatefulMcpServer();
}

/**
 * Misconfigured stateful MCP factory. Used by
 * Test 3 to verify the dedicated-worker startup failure path produces a
 * `DedicatedWorkerFailure` `ApplicationFailure`.
 */
export function brokenStatefulMcpFactory(_factoryArgument?: unknown): MCPServer {
  throw new Error('intentionally broken stateful MCP factory');
}

/**
 * Second stateless MCP server, attached only to Agent B in the
 * comprehensive scenario. Lets the trace assertions verify that
 * post-handoff agents still call `listTools` for servers they don't
 * share with the pre-handoff agent. The agent-SDK caches by server
 * name, so the shared stateless/stateful servers hit the cache when
 * Agent B initializes and emit no `mcp_tools` span; a B-only server
 * has a fresh cache key and DOES emit `mcp_tools` for Agent B's setup.
 */
export const mockStatelessMcpBOnlyFactory = (_factoryArgument?: unknown): MCPServer => ({
  cacheToolsList: false,
  name: 'mockStatelessMcpBOnly',
  async connect() {},
  async close() {},
  async listTools() {
    return [
      {
        name: 'agentBOnlyTool',
        description: 'A tool only Agent B has access to',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ];
  },
  async callTool(_toolName: string, _args: Record<string, unknown> | null) {
    // The test's fake model script never invokes `agentBOnlyTool`; the
    // server exists purely to drive a post-handoff `listTools` activity
    // for trace-shape coverage. If the model script changes to call it,
    // this returns canned text so callers don't see an undefined-result.
    return [{ type: 'text', text: '[stateless-b] agentBOnlyTool was called' }];
  },
  async invalidateToolsCache() {},
});
