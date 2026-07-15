/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Worker-side Activity implementations — the only module importing worker-runtime
 * packages (`@temporalio/activity`, `@temporalio/workflow-streams/client`), so it
 * is tree-shaken out of the Workflow bundle. Workflows pass only the model/toolset
 * name; the real `BaseLlm`/MCP session is rebuilt here and API keys stay
 * worker-side, never in activity inputs.
 */

import {
  LLMRegistry,
  MCPToolset,
  isBaseToolset,
  type BaseLlm,
  type BaseToolset,
  type Context as AdkToolContext,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import type { FunctionDeclaration } from '@google/genai';
import type { Duration } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import { Context as ActivityContext } from '@temporalio/activity';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';

import type { InvokeModelArgs, InvokeModelStreamingArgs, ModelActivities, WireLlmRequest } from './model.js';
import type { MCPCallToolArgs, MCPToolsetFactory } from './mcp.js';

const DEFAULT_STREAM_BATCH_INTERVAL = '100 milliseconds';

/** HTTP statuses that are retryable independent of the upstream's hints. */
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
    async invokeModel(args: InvokeModelArgs): Promise<LlmResponse[]> {
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

    async invokeModelStreaming(args: InvokeModelStreamingArgs): Promise<LlmResponse[]> {
      // Dispose the stream client in `finally`, not via `await using` — the
      // latter isn't parseable on this package's Node 20 floor and would
      // SyntaxError at module load.
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

/** Builds the per-server `<name>-listTools` / `<name>-callTool` pairs; MCP is session-per-call. @internal */
export function createMCPActivities(
  toolsets: Record<string, MCPToolsetFactory> = {}
): Record<string, (args: never) => Promise<unknown>> {
  const activities: Record<string, (args: never) => Promise<unknown>> = {};
  for (const [name, factory] of Object.entries(toolsets)) {
    Object.assign(activities, mcpActivitiesForName(name, factory));
  }
  return activities;
}

function mcpActivitiesForName(
  name: string,
  factory: MCPToolsetFactory
): Record<string, (args: never) => Promise<unknown>> {
  const resolveToolset = (): BaseToolset => {
    const produced = factory();
    return isBaseToolset(produced) ? produced : new MCPToolset(produced);
  };

  return {
    [`${name}-listTools`]: async (): Promise<FunctionDeclaration[]> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      let toolset: BaseToolset | undefined;
      try {
        toolset = resolveToolset();
        const tools = await toolset.getTools();
        return tools.map((tool) => tool._getDeclaration()).filter((d): d is FunctionDeclaration => d !== undefined);
      } catch (err) {
        throw toApplicationFailure(err);
      } finally {
        try {
          await toolset?.close();
        } catch {
          /* a close failure must not mask the primary result/error */
        }
        stopHeartbeat();
      }
    },

    [`${name}-callTool`]: async (args: MCPCallToolArgs): Promise<unknown> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      let toolset: BaseToolset | undefined;
      try {
        toolset = resolveToolset();
        const tools = await toolset.getTools();
        const tool = tools.find((t) => t.name === args.toolName);
        if (!tool) {
          throw ApplicationFailure.nonRetryable(
            `Tool '${args.toolName}' not found on MCP server '${name}'.`,
            'GoogleAdkMCPToolNotFound'
          );
        }
        // The MCP tool reads `toolContext.abortSignal`; supply the Activity's
        // cancellation signal so a cancelled Workflow aborts the call.
        const toolContext = {
          abortSignal: ActivityContext.current().cancellationSignal,
        } as unknown as AdkToolContext;
        return await tool.runAsync({ args: args.args, toolContext });
      } catch (err) {
        throw toApplicationFailure(err);
      } finally {
        try {
          await toolset?.close();
        } catch {
          /* a close failure must not mask the primary result/error */
        }
        stopHeartbeat();
      }
    },
  };
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

/**
 * Maps a GenAI/MCP error into Temporal's retry contract: 408/409/429/5xx (or
 * `x-should-retry: true`) → retryable, other 4xx (or `x-should-retry: false`) →
 * non-retryable; `retry-after[-ms]` → `nextRetryDelay`. Existing
 * `ApplicationFailure`s pass through unchanged.
 * @internal
 */
export function toApplicationFailure(err: unknown): ApplicationFailure {
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
    type: status !== undefined ? `GoogleAdkModelError.${status}` : 'GoogleAdkModelError',
    nonRetryable: !retryable,
    nextRetryDelay: parseRetryAfter(headers),
  });
}

function readStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
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
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const raw = e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers;
  if (!raw || typeof raw !== 'object') return undefined;

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
