/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Workflow-side model boundary for the Google ADK Temporal plugin.
 *
 * `TemporalLlm` is a drop-in `BaseLlm` (from `@google/adk`) that a user places
 * on their agent (`model: new TemporalLlm('gemini-2.5-flash')`). Inside a
 * Temporal Workflow it routes inference to the `invokeModel` /
 * `invokeModelStreaming` Activities; outside a Workflow it delegates to the
 * real model resolved from the ADK `LLMRegistry`, so the same agent object
 * works in tests and in direct (non-Temporal) ADK use.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph (the
 * public barrel re-exports it and user Workflows import `TemporalLlm`). It must
 * therefore NOT import any worker-only module (`@temporalio/activity`,
 * `@temporalio/workflow-streams`). The Activity *implementations* live in
 * `./activities.ts`, which only `plugin.ts` imports.
 */

import type { ActivityOptions, Duration, RetryPolicy } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import { inWorkflowContext, proxyActivities } from '@temporalio/workflow';
import {
  BaseLlm,
  LLMRegistry,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

/**
 * Per-call Temporal Activity options shared by the model and MCP boundaries.
 *
 * These are read on the **workflow side** when proxying the Activity, so they
 * live on the workflow-side wrapper (`TemporalLlm` / `TemporalMcpToolset`)
 * rather than on the worker-side plugin options.
 *
 * @experimental
 */
export interface TemporalActivityOptions {
  /** Maximum execution time for a single model/tool Activity attempt. */
  startToCloseTimeout?: Duration;
  /** Maximum total time across retries for the Activity. */
  scheduleToCloseTimeout?: Duration;
  /**
   * Heartbeat timeout. When set, the Activity auto-heartbeats at ~half this
   * interval so a slow (thinking-mode) model is not mistaken for a stuck
   * worker and cancelled.
   */
  heartbeatTimeout?: Duration;
  /** Temporal {@link RetryPolicy} governing model/tool retries. */
  retry?: RetryPolicy;
  /** Route the Activity to a dedicated task queue (e.g. a GPU pool). */
  taskQueue?: string;
}

/**
 * Options for {@link TemporalLlm}. Extends {@link TemporalActivityOptions}
 * with model-specific knobs (UI summary + streaming).
 *
 * @experimental
 */
export interface TemporalLlmOptions extends TemporalActivityOptions {
  /**
   * A Temporal-UI summary for each model Activity. A function receives the
   * outgoing {@link LlmRequest} so callers can derive a label from it; keep
   * it deterministic for replay safety.
   */
  summary?: string | ((req: LlmRequest) => string);
  /**
   * Stream topic for incremental (SSE) responses, surfaced via
   * `@temporalio/workflow-streams`. When set and `stream` is requested, the
   * Activity publishes each `LlmResponse` chunk to this topic for external
   * observers while still returning the full accumulated transcript to the
   * Workflow (deterministic on replay).
   */
  streamingTopic?: string;
  /** Coalescing interval for streamed chunks (default `'100 milliseconds'`). */
  streamingBatchInterval?: Duration;
}

/** Arguments for the `invokeModel` Activity. @experimental */
export interface InvokeModelArgs {
  /** Registered model name; reconstructed on the worker. */
  model: string;
  /** The serializable LlmRequest with live `toolsDict` stripped. */
  request: WireLlmRequest;
}

/** Arguments for the `invokeModelStreaming` Activity. @experimental */
export interface InvokeModelStreamingArgs extends InvokeModelArgs {
  /** Stream topic to publish chunks to. */
  streamingTopic: string;
  /** Coalescing interval for stream batching. */
  batchInterval?: Duration;
}

/**
 * The JSON-serializable shape of an ADK {@link LlmRequest} that crosses the
 * Activity boundary. ADK's `toolsDict` (live `BaseTool` objects) and
 * `liveConnectConfig` are stripped; the model still sees tool schemas via
 * `config.tools[].functionDeclarations`.
 *
 * @experimental
 */
export type WireLlmRequest = Omit<LlmRequest, 'toolsDict' | 'liveConnectConfig'>;

/**
 * The Activity interface proxied by {@link TemporalLlm} inside a Workflow.
 *
 * @experimental
 */
export interface ModelActivities {
  /** Non-streaming inference; returns the full response transcript. */
  invokeModel(args: InvokeModelArgs): Promise<LlmResponse[]>;
  /** Streaming (SSE) inference; publishes chunks and returns the transcript. */
  invokeModelStreaming(args: InvokeModelStreamingArgs): Promise<LlmResponse[]>;
}

const DEFAULT_MODEL_START_TO_CLOSE: Duration = '10 minutes';

/**
 * A {@link BaseLlm} whose inference is durable under Temporal.
 *
 * Swap a user's `model: 'gemini-2.5-flash'` for
 * `model: new TemporalLlm('gemini-2.5-flash')` — every model call inside the
 * Workflow becomes a retriable, observable Activity, while the surrounding
 * ADK agent loop replays deterministically.
 *
 * @experimental
 */
export class TemporalLlm extends BaseLlm {
  private readonly options: TemporalLlmOptions;

  /**
   * @param model   A model name registered in the ADK {@link LLMRegistry}
   *                (or resolvable by a custom `modelProvider` on the plugin).
   * @param options Per-model Activity configuration.
   */
  constructor(model: string, options: TemporalLlmOptions = {}) {
    super({ model });
    this.options = options;
  }

  /**
   * Generates content for `llmRequest`. Inside a Workflow this proxies the
   * model Activity; outside a Workflow it delegates to the real registered
   * model so the same object is usable in non-Temporal contexts.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    if (!inWorkflowContext()) {
      const real = LLMRegistry.newLlm(this.model);
      yield* real.generateContentAsync(llmRequest, stream, abortSignal);
      return;
    }

    const activities = proxyActivities<ModelActivities>({
      startToCloseTimeout: this.options.startToCloseTimeout ?? DEFAULT_MODEL_START_TO_CLOSE,
      scheduleToCloseTimeout: this.options.scheduleToCloseTimeout,
      heartbeatTimeout: this.options.heartbeatTimeout,
      retry: this.options.retry,
      taskQueue: this.options.taskQueue,
      summary: this.resolveSummary(llmRequest),
    });

    const wire = toWireRequest(llmRequest);

    let responses: LlmResponse[];
    if (stream && this.options.streamingTopic) {
      responses = await activities.invokeModelStreaming({
        model: this.model,
        request: wire,
        streamingTopic: this.options.streamingTopic,
        batchInterval: this.options.streamingBatchInterval,
      });
    } else {
      responses = await activities.invokeModel({ model: this.model, request: wire });
    }

    for (const response of responses) {
      yield response;
    }
  }

  /**
   * Live bidirectional (BIDI) connections are not supported inside a Workflow
   * — a long-lived two-way stream does not map onto the request/response
   * Activity boundary. Outside a Workflow this delegates to the real model.
   */
  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    if (inWorkflowContext()) {
      throw ApplicationFailure.nonRetryable(
        'TemporalLlm.connect (BIDI live streaming) is not supported inside a Temporal ' +
          'Workflow. Use StreamingMode.SSE (streamingTopic) for streaming, or run live ' +
          'connections outside the Workflow.',
        'GoogleAdkUnsupported',
      );
    }
    const real = LLMRegistry.newLlm(this.model);
    return real.connect(llmRequest);
  }

  private resolveSummary(req: LlmRequest): string {
    const summary = this.options.summary;
    if (typeof summary === 'function') {
      return summary(req);
    }
    if (typeof summary === 'string') {
      return summary;
    }
    return `adk.invokeModel ${this.model}`;
  }
}

/**
 * Strips the non-serializable fields (`toolsDict`, `liveConnectConfig`) from an
 * {@link LlmRequest} so it can cross the Activity boundary. Tool *schemas*
 * survive in `config.tools`.
 *
 * @experimental
 */
export function toWireRequest(llmRequest: LlmRequest): WireLlmRequest {
  // Destructure to drop the live-object fields; the rest is JSON-serializable.
  const { toolsDict: _toolsDict, liveConnectConfig: _liveConnectConfig, ...wire } = llmRequest;
  return wire;
}

/**
 * Builds {@link ActivityOptions} from {@link TemporalActivityOptions} plus a
 * UI summary, defaulting `startToCloseTimeout`. Shared by the MCP and
 * `activityAsTool` boundaries so every Activity carries a `summary`.
 *
 * @experimental
 */
export function activityOptionsFrom(
  options: TemporalActivityOptions | undefined,
  summary: string,
): ActivityOptions {
  return {
    startToCloseTimeout: options?.startToCloseTimeout ?? '5 minutes',
    scheduleToCloseTimeout: options?.scheduleToCloseTimeout,
    heartbeatTimeout: options?.heartbeatTimeout,
    retry: options?.retry,
    taskQueue: options?.taskQueue,
    summary,
  };
}
