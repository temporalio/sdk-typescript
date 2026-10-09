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
import { ApplicationFailure, type Duration } from '@temporalio/common';
import { type ActivityOptions, CancellationScope, inWorkflowContext, proxyActivities } from '@temporalio/workflow';

import { recordAbsorbedFailure, recordModelSuccess, startModelCall } from './absorbed-failure';
import { STREAMING_TOPIC_REQUIRED_FAILURE_TYPE, UNSUPPORTED_FAILURE_TYPE } from './error-types';

export interface TemporalModelOptions {
  /**
   * Per-call Temporal Activity configuration (timeouts, retry, task queue).
   *
   * When ADK aborts the invocation a call belongs to (in a graph, when a sibling
   * node fails), the call's Activity cancellation is requested, and
   * `cancellationType` decides what the agent then waits for. Unset means
   * `TRY_CANCEL`: the call ends at once and the Activity winds down on its own.
   * `WAIT_CANCELLATION_COMPLETED` waits for the Activity to acknowledge, which it
   * does at its next heartbeat; the model Activities heartbeat at half the
   * `heartbeatTimeout`, and not at all without one.
   *
   * A `timeout` on the agent's graph node is not such an abort. ADK runs the agent
   * with the run's signal, not the node's deadline (`runLlmAgentAsNode`), so a
   * node that times out leaves its model call running, and an ADK retry starts the
   * next call beside it. Bound the call with this Activity's own
   * `startToCloseTimeout` or `scheduleToCloseTimeout` instead.
   */
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
    const agentName = llmRequest.config?.labels?.[ADK_AGENT_NAME_LABEL];
    // Numbered before anything is scheduled, so that a failure arriving after a later call
    // by the same agent answered can be recognised as one ADK has moved past.
    const call = agentName === undefined ? undefined : startModelCall(agentName, abortSignal);

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
        responses = await underAbortSignal(abortSignal, () =>
          activities['adk-invokeModelStreaming']({
            model: this.model,
            request: wire,
            streamingTopic,
            batchInterval: this.options.streamingBatchInterval,
          })
        );
      } else {
        responses = await underAbortSignal(abortSignal, () =>
          activities['adk-invokeModel']({ model: this.model, request: wire })
        );
      }
    } catch (err) {
      if (call !== undefined) recordAbsorbedFailure(err, call);
      throw err;
    }
    // This agent got an answer, so a failure of its own from a call that started earlier in
    // the same invocation (a node retry, a re-activated graph node, or the call a timed-out
    // attempt left running) has been recovered from and must not fail the Workflow the run
    // is about to finish normally. `abortSignal` is ADK's `InvocationContext.abortSignal`,
    // which identifies that invocation.
    if (call !== undefined) recordModelSuccess(call);

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
 * Runs a model Activity in a cancellable `CancellationScope` that ADK's abort signal
 * cancels, so an ADK abort reaches the Activity as an ordinary, replay-safe cancellation.
 *
 * Inside a `Workflow` graph the signal is the run's own, shared by every node
 * (`InvocationContext.abortSignal`). ADK aborts it when a sibling node fails, then waits for
 * every outstanding node before failing the run (`Workflow.cleanupPending`), and an agent
 * node cannot unwind while its model call is still waiting on the Activity: without the
 * cancel, the call would hold the run until the Activity ended on its own, retries included.
 * Cancelled, the call fails as any cancelled Activity call does (an `ActivityFailure` whose
 * cause is the `CancelledFailure`, or the scope's `CancelledFailure` when the signal had
 * already aborted, in which case nothing is scheduled). ADK absorbs that like any model
 * error, and the run fails with the sibling's failure: the execution itself was not
 * cancelled, so the recorded cancellation does not decide its outcome
 * (`absorbed-failure.ts`). When the cancel counts as settled is the Activity's
 * `cancellationType`.
 *
 * The listener is removed once the call settles, because the signal outlives it, and it
 * never throws: it runs inside a host `EventTarget` dispatch, outside the Workflow's own
 * error handling. Without a signal (a plain agent turn) the call runs as it is.
 */
async function underAbortSignal<T>(signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
  if (signal === undefined) return call();
  const scope = new CancellationScope({ cancellable: true });
  const cancel = (): void => {
    try {
      scope.cancel();
    } catch {
      /* nothing to surface from inside the signal's dispatch */
    }
  };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  try {
    return await scope.run(call);
  } finally {
    signal.removeEventListener('abort', cancel);
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
 * UI summary, defaulting `startToCloseTimeout`. Shared by the MCP,
 * `activityAsTool` and `activityNode` boundaries so every Activity carries a
 * `summary`; a caller-supplied `options.summary` takes precedence over
 * `defaultSummary`.
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
