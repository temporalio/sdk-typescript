/**
 * Worker-side Activity implementations for the Google ADK Temporal plugin — no
 * module in the `./workflow` import graph reaches this one, so the
 * worker-runtime packages it pulls in (`@temporalio/activity`,
 * `@temporalio/workflow-streams/client`) stay out of the Workflow bundle.
 * Workflows pass a model/toolset name rather than a live `BaseLlm`/MCP session;
 * both are rebuilt here, and the plugin never puts API keys in activity inputs.
 *
 * This module runs on the worker, where `@google/adk` resolves to its full
 * (node) barrel — the one that includes MCP. The Workflow bundle pins ADK's web
 * surface, which does not.
 */

import {
  LLMRegistry,
  MCPSessionManager,
  MCPToolset,
  isBaseToolset,
  type BaseLlm,
  type BaseToolset,
  type Context as AdkToolContext,
  type LlmRequest,
  type LlmResponse,
  type MCPConnectionParams,
} from '@google/adk';
import type { FunctionDeclaration } from '@google/genai';
import type { Duration } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import { Context as ActivityContext } from '@temporalio/activity';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';

import {
  MCP_ERROR_FAILURE_TYPE,
  MCP_RESOURCES_UNSUPPORTED_FAILURE_TYPE,
  MCP_TOOL_NOT_FOUND_FAILURE_TYPE,
  MODEL_ERROR_FAILURE_TYPE,
} from './error-types';
import type { InvokeModelArgs, InvokeModelStreamingArgs, ModelActivities, WireLlmRequest } from './model';
import type { MCPCallToolArgs, MCPReadResourceArgs, MCPResourceContents, MCPToolsetFactory } from './mcp';

const DEFAULT_STREAM_BATCH_INTERVAL = '100 milliseconds';

const RETRYABLE_STATUS = new Set([408, 409, 429]);

/** Kept local (not imported from `plugin.ts`) to avoid an import cycle. @internal */
export interface ModelActivitiesOptions {
  /** Reconstructs a `BaseLlm` from a model name; defaults to the ADK registry. */
  modelProvider?: (model: string) => BaseLlm;
}

/** @internal */
export function createModelActivities(options: ModelActivitiesOptions = {}): ModelActivities {
  const resolveModel = (model: string): BaseLlm => options.modelProvider?.(model) ?? LLMRegistry.newLlm(model);

  return {
    async 'adk-invokeModel'(args: InvokeModelArgs): Promise<LlmResponse[]> {
      const stopHeartbeat = startAdaptiveHeartbeat();
      try {
        const model = resolveModel(args.model);
        const request = fromWireRequest(args.request);
        const abortSignal = ActivityContext.current().cancellationSignal;
        const responses: LlmResponse[] = [];
        for await (const response of model.generateContentAsync(request, false, abortSignal)) {
          responses.push(response);
        }
        return responses;
      } catch (err) {
        throw toApplicationFailure(err);
      } finally {
        stopHeartbeat();
      }
    },

    async 'adk-invokeModelStreaming'(args: InvokeModelStreamingArgs): Promise<LlmResponse[]> {
      const stopHeartbeat = startAdaptiveHeartbeat();
      let stream: ReturnType<typeof WorkflowStreamClient.fromWithinActivity> | undefined;
      try {
        stream = WorkflowStreamClient.fromWithinActivity({
          batchInterval: args.batchInterval ?? DEFAULT_STREAM_BATCH_INTERVAL,
        });
        const events = stream.topic<LlmResponse>(args.streamingTopic);
        const model = resolveModel(args.model);
        const request = fromWireRequest(args.request);
        const abortSignal = ActivityContext.current().cancellationSignal;
        const responses: LlmResponse[] = [];
        for await (const response of model.generateContentAsync(request, true, abortSignal)) {
          // Heartbeat per chunk so a slow stream isn't mistaken for a stuck worker.
          ActivityContext.current().heartbeat();
          events.publish(response);
          responses.push(response);
        }
        return responses;
      } catch (err) {
        throw toApplicationFailure(err);
      } finally {
        try {
          await stream?.[Symbol.asyncDispose]();
        } catch {
          /* a dispose failure must not mask the primary result/error */
        } finally {
          stopHeartbeat();
        }
      }
    },
  };
}

/**
 * Builds the per-server `<name>-listTools` / `<name>-callTool` /
 * `<name>-listResources` / `<name>-readResource` Activities. @internal
 */
export function createMCPActivities(
  toolsets: Record<string, MCPToolsetFactory> = {}
): Record<string, (args: never) => Promise<unknown>> {
  const activities: Record<string, (args: never) => Promise<unknown>> = {};
  for (const [name, factory] of Object.entries(toolsets)) {
    Object.assign(activities, mcpActivitiesForName(name, factory));
  }
  return activities;
}

/** One live MCP session, as produced by ADK's `MCPSessionManager`. */
type MCPSession = Awaited<ReturnType<MCPSessionManager['createSession']>>;

/**
 * The resource methods ADK 2.0 added to `MCPToolset`, duck-typed so a
 * factory-supplied toolset (a real `MCPToolset`, or a test double) qualifies
 * without a class check across two ADK copies.
 */
interface ResourceCapableToolset {
  listResources(): Promise<string[]>;
  readResource(name: string): Promise<MCPResourceContents[]>;
}

function resourceCapable(toolset: BaseToolset, name: string): ResourceCapableToolset {
  const candidate = toolset as Partial<ResourceCapableToolset>;
  if (typeof candidate.listResources === 'function' && typeof candidate.readResource === 'function') {
    return candidate as ResourceCapableToolset;
  }
  throw ApplicationFailure.nonRetryable(
    `The toolset registered for MCP server '${name}' cannot serve resources: it has no ` +
      "'listResources' / 'readResource' methods. Return an MCPToolset (or MCPConnectionParams) from the factory.",
    MCP_RESOURCES_UNSUPPORTED_FAILURE_TYPE
  );
}

function mcpActivitiesForName(
  name: string,
  factory: MCPToolsetFactory
): Record<string, (args: never) => Promise<unknown>> {
  return {
    [`${name}-listTools`]: async (): Promise<FunctionDeclaration[]> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      let owned: MCPToolset | undefined;
      try {
        const produced = factory();
        const toolset = isBaseToolset(produced) ? produced : (owned = new MCPToolset(produced));
        const tools = await toolset.getTools();
        // `_getDeclaration` is underscore-prefixed by ADK convention but is a
        // typed, documented `BaseTool` member; ADK's own default
        // `processLlmRequest` calls it the same way.
        return tools.map((tool) => tool._getDeclaration()).filter((d): d is FunctionDeclaration => d !== undefined);
      } catch (err) {
        throw toApplicationFailure(err, MCP_ERROR_FAILURE_TYPE);
      } finally {
        try {
          await owned?.close();
        } catch {
          /* a close failure must not mask the primary result/error */
        }
        stopHeartbeat();
      }
    },

    [`${name}-callTool`]: async (args: MCPCallToolArgs): Promise<unknown> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      try {
        const abortSignal = ActivityContext.current().cancellationSignal;
        const produced = factory();
        if (!isBaseToolset(produced)) {
          return await withOneSession(produced, (session) =>
            session.callTool({ name: args.toolName, arguments: args.args }, undefined, { signal: abortSignal })
          );
        }
        const tools = await produced.getTools();
        const tool = tools.find((t) => t.name === args.toolName);
        if (!tool) {
          throw ApplicationFailure.nonRetryable(
            `Tool '${args.toolName}' not found on MCP server '${name}'.`,
            MCP_TOOL_NOT_FOUND_FAILURE_TYPE
          );
        }
        // The MCP tool reads `toolContext.abortSignal`; supply the Activity's
        // cancellation signal so a cancelled Workflow aborts the call.
        const toolContext = { abortSignal } as unknown as AdkToolContext;
        return await tool.runAsync({ args: args.args, toolContext });
      } catch (err) {
        throw toApplicationFailure(err, MCP_ERROR_FAILURE_TYPE);
      } finally {
        stopHeartbeat();
      }
    },

    [`${name}-listResources`]: async (): Promise<string[]> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      try {
        const abortSignal = ActivityContext.current().cancellationSignal;
        const produced = factory();
        if (!isBaseToolset(produced)) {
          return await withOneSession(produced, async (session) => {
            const result = await session.listResources(undefined, { signal: abortSignal });
            return result.resources.map((resource) => resource.name);
          });
        }
        return await resourceCapable(produced, name).listResources();
      } catch (err) {
        throw toApplicationFailure(err, MCP_ERROR_FAILURE_TYPE);
      } finally {
        stopHeartbeat();
      }
    },

    [`${name}-readResource`]: async (args: MCPReadResourceArgs): Promise<MCPResourceContents[]> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      try {
        const abortSignal = ActivityContext.current().cancellationSignal;
        const produced = factory();
        if (!isBaseToolset(produced)) {
          // One session for the name → URI lookup and the read; ADK's own
          // `MCPToolset.readResource(name)` opens two.
          return await withOneSession(produced, async (session) => {
            const listed = await session.listResources(undefined, { signal: abortSignal });
            const resource = listed.resources.find((candidate) => candidate.name === args.name);
            if (!resource) throw new Error(`Resource with name '${args.name}' not found.`);
            if (!resource.uri) throw new Error(`Resource '${args.name}' has no URI.`);
            const result = await session.readResource({ uri: resource.uri }, { signal: abortSignal });
            return result.contents as MCPResourceContents[];
          });
        }
        return await resourceCapable(produced, name).readResource(args.name);
      } catch (err) {
        throw toApplicationFailure(err, MCP_ERROR_FAILURE_TYPE);
      } finally {
        stopHeartbeat();
      }
    },
  };
}

/** Opens one MCP session for `fn` and closes it afterwards. */
async function withOneSession<T>(
  connectionParams: MCPConnectionParams,
  fn: (session: MCPSession) => Promise<T>
): Promise<T> {
  const sessions = new MCPSessionManager(connectionParams);
  const session = await sessions.createSession();
  try {
    return await fn(session);
  } finally {
    try {
      await sessions.closeSession(session);
    } catch {
      /* a close failure must not mask the primary result/error */
    }
  }
}

/**
 * Rebuilds an {@link LlmRequest} from its wire shape (stripped live-object fields
 * restored as empty containers; tools re-derived from `config.tools`) and disables
 * the model's own HTTP retries so Temporal is the sole retry authority.
 */
function fromWireRequest(wire: WireLlmRequest): LlmRequest {
  const request = { ...wire, toolsDict: {}, liveConnectConfig: {} } as LlmRequest;
  disableSdkRetries(request);
  return request;
}

/**
 * Pins the genai client to a single attempt (`config.httpOptions.retryOptions.attempts = 1`)
 * so Temporal's `RetryPolicy` is the sole retry authority — otherwise the SDK's own
 * retries nest a second loop inside each Activity attempt (a retry storm).
 */
function disableSdkRetries(request: LlmRequest): void {
  const config = (request.config ?? {}) as {
    httpOptions?: { retryOptions?: { attempts?: number } };
  };
  config.httpOptions = {
    ...config.httpOptions,
    retryOptions: { ...config.httpOptions?.retryOptions, attempts: 1 },
  };
  (request as { config: unknown }).config = config;
}

/**
 * Starts an auto-heartbeat at ~half the Activity's `heartbeatTimeout` so a slow
 * (thinking-mode) model call is not mistaken for a stuck worker. Returns a stop
 * function; a no-op when no heartbeat timeout is configured.
 */
function startAdaptiveHeartbeat(): () => void {
  const heartbeatTimeoutMs = ActivityContext.current().info.heartbeatTimeoutMs;
  if (heartbeatTimeoutMs === undefined || heartbeatTimeoutMs <= 0) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    try {
      ActivityContext.current().heartbeat();
    } catch {
      /* outside an Activity context (e.g. after return) — ignore */
    }
  }, heartbeatTimeoutMs / 2);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return () => clearInterval(timer);
}

/** @internal */
export function toApplicationFailure(err: unknown, baseType: string = MODEL_ERROR_FAILURE_TYPE): ApplicationFailure {
  if (err instanceof ApplicationFailure) {
    return err;
  }

  const status = readStatus(err);
  const headers = readHeaders(err);
  const message = err instanceof Error ? err.message : String(err);

  let retryable = status === undefined ? true : RETRYABLE_STATUS.has(status) || (status >= 500 && status < 600);
  const shouldRetry = headers?.['x-should-retry'];
  if (shouldRetry === 'false') {
    retryable = false;
  } else if (shouldRetry === 'true') {
    retryable = true;
  }

  return ApplicationFailure.create({
    message,
    type: status !== undefined ? `${baseType}.${status}` : baseType,
    nonRetryable: !retryable,
    nextRetryDelay: parseRetryAfter(headers),
  });
}

/** Bound on how far down an error's `cause` chain the HTTP status/headers are looked for. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Walks `err` and its `cause` chain — ADK 2.0 wraps MCP session failures as
 * `new Error('Failed to create MCP session: …', { cause })`, so the transport
 * error carrying the status sits one level down.
 */
function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

function readStatus(err: unknown): number | undefined {
  for (const e of causeChain(err)) {
    if (typeof e.status === 'number') return e.status;
    if (typeof e.status === 'string' && /^\d+$/.test(e.status)) return Number(e.status);
    const response = e.response as Record<string, unknown> | undefined;
    if (response && typeof response === 'object') {
      if (typeof response.status === 'number') return response.status;
      if (typeof response.status === 'string' && /^\d+$/.test(response.status)) return Number(response.status);
    }
  }
  return undefined;
}

function readHeaders(err: unknown): Record<string, string> | undefined {
  for (const e of causeChain(err)) {
    const raw = e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers;
    if (!raw || typeof raw !== 'object') continue;

    const maybeHeaders = raw as { forEach?: (cb: (value: string, key: string) => void) => void };
    if (typeof maybeHeaders.forEach === 'function') {
      const out: Record<string, string> = {};
      maybeHeaders.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      return out;
    }
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
  }
  return undefined;
}

/**
 * Reads `retry-after-ms` / `retry-after` into a Temporal `Duration`.
 * `retry-after` accepts both RFC 7231 forms: delta-seconds and HTTP-date
 * (converted to a delta from now — fine here, this runs in an Activity).
 */
function parseRetryAfter(headers: Record<string, string> | undefined): Duration | undefined {
  if (!headers) return undefined;
  const ms = headers['retry-after-ms'];
  if (ms && /^\d+$/.test(ms)) return `${Number(ms)} milliseconds` as Duration;
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return `${Number(retryAfter)} seconds` as Duration;
    const dateMs = Date.parse(retryAfter);
    const now = Date.now();
    if (!Number.isNaN(dateMs) && dateMs > now) return `${dateMs - now} milliseconds` as Duration;
  }
  return undefined;
}
