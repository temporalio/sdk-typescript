/**
 * Workflow-side model boundary for the Google ADK Temporal plugin.
 *
 * `TemporalModel` is a drop-in `BaseLlm` (from `@google/adk`) that a user places
 * on their agent (`model: new TemporalModel('gemini-2.5-flash')`). Inside a
 * Temporal Workflow it routes inference to the `adk-invokeModel` /
 * `adk-invokeModelStreaming` Activities; outside a Workflow it delegates to the
 * real model resolved from the ADK `LLMRegistry`, so the same agent object
 * works in tests and in direct (non-Temporal) ADK use.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph (the
 * `./workflow` entry point re-exports it and user Workflows import
 * `TemporalModel`). It must therefore NOT import any worker-only module
 * (`@temporalio/activity`, `@temporalio/workflow-streams/client`). The Activity
 * *implementations* live in `./activities.ts`, which nothing in that graph
 * imports.
 */

import { BaseLlm, LLMRegistry, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { ActivityOptions, Duration } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import { inWorkflowContext, proxyActivities } from '@temporalio/workflow';

import { recordAbsorbedFailure } from './absorbed-failure';
import { STREAMING_TOPIC_REQUIRED_FAILURE_TYPE, UNSUPPORTED_FAILURE_TYPE } from './error-types';

export interface TemporalModelOptions {
  /** Per-call Temporal Activity configuration (timeouts, retry, task queue). */
  activity?: ActivityOptions;
  /**
   * A Temporal-UI summary for each model Activity. A function receives the
   * outgoing {@link LlmRequest} so callers can derive a label from it; keep
   * it deterministic for replay safety. Takes precedence over
   * `activity.summary`; when neither is set, the request's `adk_agent_name`
   * label is used, falling back to a generic auto-generated label.
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

/** @internal */
export interface InvokeModelArgs {
  /** Registered model name; reconstructed on the worker. */
  model: string;
  /** The serializable LlmRequest with live `toolsDict` stripped. */
  request: WireLlmRequest;
}

/** @internal */
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
 * @internal
 */
export type WireLlmRequest = Omit<LlmRequest, 'toolsDict' | 'liveConnectConfig'>;

/**
 * The Activity interface proxied by {@link TemporalModel} inside a Workflow.
 *
 * @internal
 */
export interface ModelActivities {
  /** Non-streaming inference; returns the full response transcript. */
  'adk-invokeModel'(args: InvokeModelArgs): Promise<LlmResponse[]>;
  /** Streaming (SSE) inference; publishes chunks and returns the transcript. */
  'adk-invokeModelStreaming'(args: InvokeModelStreamingArgs): Promise<LlmResponse[]>;
}

const DEFAULT_MODEL_START_TO_CLOSE: Duration = '1 minute';

const ADK_AGENT_NAME_LABEL = 'adk_agent_name';

/**
 * A {@link BaseLlm} whose inference is durable under Temporal.
 *
 * Swap a user's `model: 'gemini-2.5-flash'` for
 * `model: new TemporalModel('gemini-2.5-flash')` — every model call inside the
 * Workflow becomes a retryable, observable Activity, while the surrounding
 * ADK agent loop replays deterministically.
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

    const streamingTopic = this.options.streamingTopic;
    // ADK's agent flow stamps this label on every request just before calling the
    // model, and a request built by hand for a direct call carries none. Only that
    // flow absorbs a throw, so only it needs the failure recorded.
    const throughAgentRun = llmRequest.config?.labels?.[ADK_AGENT_NAME_LABEL] !== undefined;

    let responses: LlmResponse[];
    try {
      const activities = proxyActivities<ModelActivities>({
        ...this.options.activity,
        startToCloseTimeout: this.options.activity?.startToCloseTimeout ?? DEFAULT_MODEL_START_TO_CLOSE,
        summary: this.resolveSummary(llmRequest),
      });
      const wire = toWireRequest(llmRequest);
      if (stream) {
        if (!streamingTopic) {
          throw ApplicationFailure.nonRetryable(
            `TemporalModel('${this.model}'): streaming was requested but no 'streamingTopic' is ` +
              'configured. Set TemporalModelOptions.streamingTopic to publish incremental chunks.',
            STREAMING_TOPIC_REQUIRED_FAILURE_TYPE
          );
        }
        responses = await activities['adk-invokeModelStreaming']({
          model: this.model,
          request: wire,
          streamingTopic,
          batchInterval: this.options.streamingBatchInterval,
        });
      } else {
        responses = await activities['adk-invokeModel']({ model: this.model, request: wire });
      }
    } catch (err) {
      if (throughAgentRun) recordAbsorbedFailure(err);
      throw err;
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
        UNSUPPORTED_FAILURE_TYPE
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
    if (this.options.activity?.summary !== undefined) {
      return this.options.activity.summary;
    }
    const agentName = req.config?.labels?.[ADK_AGENT_NAME_LABEL];
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
function toWireRequest(llmRequest: LlmRequest): WireLlmRequest {
  const { toolsDict: _toolsDict, liveConnectConfig: _liveConnectConfig, ...wire } = llmRequest;
  return wire;
}

/**
 * Builds {@link ActivityOptions} from per-call {@link ActivityOptions} plus a
 * UI summary, defaulting `startToCloseTimeout`. Shared by the MCP and
 * `activityAsTool` boundaries so every Activity carries a `summary`; a
 * caller-supplied `options.summary` takes precedence over `defaultSummary`.
 *
 * @internal
 */
export function activityOptionsFrom(options: ActivityOptions | undefined, defaultSummary: string): ActivityOptions {
  return {
    ...options,
    startToCloseTimeout: options?.startToCloseTimeout ?? DEFAULT_MODEL_START_TO_CLOSE,
    summary: options?.summary ?? defaultSummary,
  };
}
