/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Worker-side Activity implementations for the Google ADK Temporal plugin.
 *
 * This module is the **only** one that imports worker-runtime packages
 * (`@temporalio/activity`, `@temporalio/workflow-streams/client`) and runs the
 * real, non-deterministic I/O: model inference and MCP server calls. It is
 * imported solely by `plugin.ts` and is therefore tree-shaken out of the
 * Workflow sandbox bundle (the workflow-reachable modules — `model.ts`,
 * `mcp.ts`, `tools.ts`, `index.ts` — never import it).
 *
 * The reconstruction boundary: workflows pass only the model **name string**
 * (and the MCP toolset **name**); these activities rebuild the real `BaseLlm`
 * via `modelProvider ?? LLMRegistry.newLlm` and the MCP session via the
 * worker-registered factory. API keys are read from the worker environment by
 * the reconstructed objects and never travel in activity inputs.
 */

import { ApplicationFailure } from '@temporalio/common';
import { Context as ActivityContext } from '@temporalio/activity';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import {
  BaseToolset,
  LLMRegistry,
  MCPToolset,
  isBaseToolset,
  type BaseLlm,
  type Context as AdkToolContext,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import type { FunctionDeclaration } from '@google/genai';

import type {
  InvokeModelArgs,
  InvokeModelStreamingArgs,
  ModelActivities,
  WireLlmRequest,
} from './model.js';
import type { McpCallToolArgs, McpToolsetFactory } from './mcp.js';

/** Default coalescing interval for streamed model chunks. */
const DEFAULT_STREAM_BATCH_INTERVAL = '100 milliseconds';

/** HTTP statuses that are retryable independent of the upstream's hints. */
const RETRYABLE_STATUS = new Set([408, 409, 429]);

/**
 * Worker-side reconstruction options consumed by {@link createModelActivities}.
 * Structurally compatible with `GoogleAdkPluginOptions` so the plugin passes
 * its options straight through (kept local to avoid a `plugin.ts` import cycle).
 *
 * @experimental
 */
export interface ModelActivitiesOptions {
  /** Reconstructs a `BaseLlm` from a model name; defaults to the ADK registry. */
  modelProvider?: (model: string) => BaseLlm;
}

/**
 * Builds the `invokeModel` / `invokeModelStreaming` Activities. Each call
 * reconstructs the real model from its name and runs inference on the worker;
 * the surrounding ADK agent loop stays in the (deterministic) Workflow.
 *
 * @experimental
 */
export function createModelActivities(options: ModelActivitiesOptions = {}): ModelActivities {
  const resolveModel = (model: string): BaseLlm =>
    options.modelProvider?.(model) ?? LLMRegistry.newLlm(model);

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
      // The stream client is an explicit async resource — disposing it flushes
      // any buffered items. We dispose it in `finally` rather than via the TC39
      // `await using` declaration: `await using` is not parseable on this
      // package's Node floor (`engines.node >= 20`), and the vitest/esbuild
      // transform passes the syntax through un-downleveled, so it would throw a
      // load-time `SyntaxError` and break every module import. Manual disposal
      // is the documented fallback (`await client[Symbol.asyncDispose]()`).
      // Chunks are published for external observers; the full, ordered
      // transcript is still returned to the Workflow (the deterministic,
      // replay-safe channel).
      const stream = WorkflowStreamClient.fromWithinActivity({
        batchInterval: args.batchInterval ?? DEFAULT_STREAM_BATCH_INTERVAL,
      });
      const events = stream.topic<LlmResponse>(args.streamingTopic);
      try {
        const model = resolveModel(args.model);
        const request = fromWireRequest(args.request);
        const abortSignal = ActivityContext.current().cancellationSignal;
        const responses: LlmResponse[] = [];
        for await (const response of model.generateContentAsync(request, true, abortSignal)) {
          // Heartbeat per chunk so a slow stream is never mistaken for a stuck
          // worker, and publish the chunk to the stream side-channel.
          ActivityContext.current().heartbeat();
          events.publish(response);
          responses.push(response);
        }
        return responses;
      } catch (err) {
        throw toApplicationFailure(err);
      } finally {
        await stream[Symbol.asyncDispose]();
      }
    },
  };
}

/**
 * Builds the `<name>-listTools` / `<name>-callTool` Activity pairs for every
 * registered MCP toolset factory. Each pair opens a real MCP session on the
 * worker (session-per-call), lists/executes, then closes it.
 *
 * @experimental
 */
export function createMcpActivities(
  toolsets: Record<string, McpToolsetFactory> = {},
): Record<string, (args: never) => Promise<unknown>> {
  const activities: Record<string, (args: never) => Promise<unknown>> = {};
  for (const [name, factory] of Object.entries(toolsets)) {
    Object.assign(activities, mcpActivitiesForName(name, factory));
  }
  return activities;
}

function mcpActivitiesForName(
  name: string,
  factory: McpToolsetFactory,
): Record<string, (args: never) => Promise<unknown>> {
  const resolveToolset = (): BaseToolset => {
    const produced = factory();
    return isBaseToolset(produced) ? produced : new MCPToolset(produced);
  };

  return {
    [`${name}-listTools`]: async (): Promise<FunctionDeclaration[]> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      const toolset = resolveToolset();
      try {
        const tools = await toolset.getTools();
        return tools
          .map((tool) => tool._getDeclaration())
          .filter((d): d is FunctionDeclaration => d !== undefined);
      } catch (err) {
        throw toApplicationFailure(err);
      } finally {
        await toolset.close().catch(() => undefined);
        stopHeartbeat();
      }
    },

    [`${name}-callTool`]: async (args: McpCallToolArgs): Promise<unknown> => {
      const stopHeartbeat = startAdaptiveHeartbeat();
      const toolset = resolveToolset();
      try {
        const tools = await toolset.getTools();
        const tool = tools.find((t) => t.name === args.toolName);
        if (!tool) {
          throw ApplicationFailure.retryable(
            `Tool '${args.toolName}' not found on MCP server '${name}'.`,
            'GoogleAdkMcpToolNotFound',
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
        await toolset.close().catch(() => undefined);
        stopHeartbeat();
      }
    },
  };
}

/**
 * Re-hydrates a {@link LlmRequest} from its wire shape by restoring the
 * stripped live-object fields as empty containers. The worker-side model
 * re-derives callable tools from `config.tools`, so empty `toolsDict` /
 * `liveConnectConfig` are sufficient.
 *
 * Also forces the reconstructed model's own HTTP retries off (see
 * {@link disableSdkRetries}) so Temporal's `RetryPolicy` is the *sole* retry
 * authority for the model call.
 */
function fromWireRequest(wire: WireLlmRequest): LlmRequest {
  const request = { ...wire, toolsDict: {}, liveConnectConfig: {} } as LlmRequest;
  disableSdkRetries(request);
  return request;
}

/**
 * Disables the underlying `@google/genai` client's internal HTTP retries by
 * pinning `config.httpOptions.retryOptions.attempts = 1` (1 = the original
 * attempt only, no retries). ADK's `Gemini` model forwards `llmRequest.config`
 * (a `GenerateContentConfig`, which carries `httpOptions`) to the genai client,
 * so this travels with the request.
 *
 * Rationale: Temporal's `RetryPolicy` already governs Activity retries with
 * backoff and `nextRetryDelay` derived from the upstream's `retry-after`
 * headers ({@link toApplicationFailure}). Leaving the SDK's own retries enabled
 * would nest a second retry loop *inside* each Activity attempt — a retry storm
 * that multiplies latency and request volume and hides the real failure from
 * Temporal. One Activity attempt == one model request; Temporal owns the rest.
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
 * Translates an error from the Google GenAI SDK (or any error raised while
 * driving the model / MCP) into Temporal's retry contract.
 *
 * - `408` / `409` / `429` / `5xx` → retryable.
 * - `x-should-retry: true` header → retryable on any status.
 * - `x-should-retry: false` header → non-retryable on any status.
 * - other `4xx` → non-retryable.
 * - `retry-after-ms` / `retry-after` headers → `nextRetryDelay` so Temporal
 *   honors the upstream's backoff.
 *
 * Errors already shaped as {@link ApplicationFailure} (e.g. tool-not-found)
 * pass through unchanged.
 */
export function toApplicationFailure(err: unknown): ApplicationFailure {
  if (err instanceof ApplicationFailure) {
    return err;
  }

  const status = readStatus(err);
  const headers = readHeaders(err);
  const message = err instanceof Error ? err.message : String(err);

  let retryable =
    status === undefined ? true : RETRYABLE_STATUS.has(status) || (status >= 500 && status < 600);
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

/** Extracts a numeric HTTP status from a GenAI / fetch-style error. */
function readStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.code === 'number') return e.code;
    if (typeof e.status === 'string' && /^\d+$/.test(e.status)) return Number(e.status);
  }
  return undefined;
}

/** Normalizes any headers carried by the error to a lower-cased record. */
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
    Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
}

/** Reads `retry-after-ms` / `retry-after` into a Temporal `Duration`. */
function parseRetryAfter(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const ms = headers['retry-after-ms'];
  if (ms && /^\d+$/.test(ms)) return `${Number(ms)} milliseconds`;
  const seconds = headers['retry-after'];
  if (seconds && /^\d+$/.test(seconds)) return `${Number(seconds)} seconds`;
  return undefined;
}
