/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Workflow-side model boundary for the Google ADK Temporal plugin.
 *
 * `TemporalModel` is a drop-in `BaseLlm` (from `@google/adk`) that a user places
 * on their agent (`model: new TemporalModel('gemini-2.5-flash')`). Inside a
 * Temporal Workflow it routes inference to the `invokeModel` /
 * `invokeModelStreaming` Activities; outside a Workflow it delegates to the
 * real model resolved from the ADK `LLMRegistry`, so the same agent object
 * works in tests and in direct (non-Temporal) ADK use.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph (the
 * public barrel re-exports it and user Workflows import `TemporalModel`). It must
 * therefore NOT import any worker-only module (`@temporalio/activity`,
 * `@temporalio/workflow-streams`). The Activity *implementations* live in
 * `./activities.ts`, which only `plugin.ts` imports.
 */

import { BaseLlm, LLMRegistry, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { ActivityOptions, Duration } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import { inWorkflowContext, proxyActivities } from '@temporalio/workflow';

/**
 * Options for {@link TemporalModel}.
 */
export interface TemporalModelOptions {
  /** Per-call Temporal Activity configuration (timeouts, retry, task queue). */
  activity?: ActivityOptions;
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

/** Arguments for the `invokeModel` Activity. */
export interface InvokeModelArgs {
  /** Registered model name; reconstructed on the worker. */
  model: string;
  /** The serializable LlmRequest with live `toolsDict` stripped. */
  request: WireLlmRequest;
}

/** Arguments for the `invokeModelStreaming` Activity. */
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
 */
export type WireLlmRequest = Omit<LlmRequest, 'toolsDict' | 'liveConnectConfig'>;

/**
 * The Activity interface proxied by {@link TemporalModel} inside a Workflow.
 */
export interface ModelActivities {
  /** Non-streaming inference; returns the full response transcript. */
  invokeModel(args: InvokeModelArgs): Promise<LlmResponse[]>;
  /** Streaming (SSE) inference; publishes chunks and returns the transcript. */
  invokeModelStreaming(args: InvokeModelStreamingArgs): Promise<LlmResponse[]>;
}

const DEFAULT_MODEL_START_TO_CLOSE: Duration = '1 minute';

/**
 * A {@link BaseLlm} whose inference is durable under Temporal.
 *
 * Swap a user's `model: 'gemini-2.5-flash'` for
 * `model: new TemporalModel('gemini-2.5-flash')` — every model call inside the
 * Workflow becomes a retriable, observable Activity, while the surrounding
 * ADK agent loop replays deterministically.
 *
 * @experimental
 */
export class TemporalModel extends BaseLlm {
  private readonly options: TemporalModelOptions;

  /**
   * @param model   A model name registered in the ADK {@link LLMRegistry}
   *                (or resolvable by a custom `modelProvider` on the plugin).
   * @param options Per-model Activity configuration.
   */
  constructor(model: string, options: TemporalModelOptions = {}) {
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
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    if (!inWorkflowContext()) {
      const real = LLMRegistry.newLlm(this.model);
      yield* real.generateContentAsync(llmRequest, stream, abortSignal);
      return;
    }

    const activities = proxyActivities<ModelActivities>({
      ...this.options.activity,
      startToCloseTimeout: this.options.activity?.startToCloseTimeout ?? DEFAULT_MODEL_START_TO_CLOSE,
      summary: this.resolveSummary(llmRequest),
    });

    const wire = toWireRequest(llmRequest);
    const streamingTopic = this.options.streamingTopic;

    let responses: LlmResponse[];
    if (stream) {
      if (!streamingTopic) {
        throw ApplicationFailure.nonRetryable(
          `TemporalModel('${this.model}'): streaming was requested but no 'streamingTopic' is ` +
            'configured. Set TemporalModelOptions.streamingTopic to publish incremental chunks.',
          'GoogleAdkStreamingTopicRequired'
        );
      }
      responses = await activities.invokeModelStreaming({
        model: this.model,
        request: wire,
        streamingTopic,
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
        'TemporalModel.connect (BIDI live streaming) is not supported inside a Temporal ' +
          'Workflow. Use StreamingMode.SSE (streamingTopic) for streaming, or run live ' +
          'connections outside the Workflow.',
        'GoogleAdkUnsupported'
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
    const agentName = req.config?.labels?.['adk_agent_name'];
    if (agentName) {
      return agentName;
    }
    return `adk.invokeModel ${this.model}`;
  }
}

/**
 * Strips the non-serializable fields (`toolsDict`, `liveConnectConfig`) from an
 * {@link LlmRequest} so it can cross the Activity boundary. Tool *schemas*
 * survive in `config.tools`.
 */
export function toWireRequest(llmRequest: LlmRequest): WireLlmRequest {
  // Destructure to drop the live-object fields; the rest is JSON-serializable.
  const { toolsDict: _toolsDict, liveConnectConfig: _liveConnectConfig, ...wire } = llmRequest;
  return wire;
}

/**
 * Builds {@link ActivityOptions} from per-call {@link ActivityOptions} plus a
 * UI summary, defaulting `startToCloseTimeout`. Shared by the MCP and
 * `activityAsTool` boundaries so every Activity carries a `summary`.
 */
export function activityOptionsFrom(options: ActivityOptions | undefined, summary: string): ActivityOptions {
  return {
    ...options,
    startToCloseTimeout: options?.startToCloseTimeout ?? '1 minute',
    summary,
  };
}
