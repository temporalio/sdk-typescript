/**
 * Surfaces the failures `@google/adk` absorbs before Workflow code can see them.
 * `LlmAgent.runAndHandleError` turns any `Error` escaping a model call into an event
 * and lets the run finish, so a Workflow whose model Activity failed returns
 * normally. `TemporalModel` records such a failure here, and the inbound interceptor
 * below re-raises it once the Workflow or handler frame that recorded it returns.
 *
 * Await an agent turn in the frame that started it: a failure recorded while that frame
 * is open surfaces there, and one recorded after a handler frame returned surfaces in the
 * main function's. One recorded after the main function returned never surfaces —
 * completing with unfinished handlers is a user error Temporal already warns about.
 *
 * The same interceptor also converts the errors ADK 2.0's workflow runtime *throws* —
 * a node past its `timeout`, an output that failed its schema, an approval ADK refused
 * to bind — from the plain `Error`s they are into non-retryable `ApplicationFailure`s.
 * The Temporal SDK fails a Workflow only for a `TemporalFailure` (or a configured
 * failure type); any other error fails the Workflow *Task*, which the server retries
 * forever. These are expected runtime outcomes of a graph, not bugs, so they must end
 * the execution (or reject the Update) with a typed failure instead.
 */

import type { AsyncLocalStorage as ALS } from 'node:async_hooks';

import { ApplicationFailure, TemporalFailure } from '@temporalio/common';
import {
  AsyncLocalStorage,
  CancellationScope,
  ContinueAsNew,
  inWorkflowContext,
  isCancellation,
  type WorkflowInterceptorsFactory,
} from '@temporalio/workflow';

import { ADK_RUNTIME_FAILURE_TYPES } from './error-types';

// Held on the per-execution sandbox `globalThis` rather than in module scope: a
// bundle can hold two copies of this module (the interceptor list registers its
// compiled path, while a Workflow reaches it through its own import of
// `TemporalModel`), and both have to reach the same recordings.
const ABSORBED = '__temporal_googleAdkAbsorbedFailures';

/**
 * One `TemporalModel` call made by an ADK agent inside a Workflow.
 *
 * @internal
 */
export interface ModelCall {
  /** The `adk_agent_name` label of the request. */
  agent: string;
  /**
   * The ADK invocation the call belongs to, identified by the `AbortSignal` ADK hands the
   * model (`InvocationContext.abortSignal`). A `Workflow` run makes one signal and gives
   * every node the same object, so a node retry and a re-activation of the same node share
   * it while a later turn does not. `undefined` for a plain agent turn, where the runner
   * sets no signal and one turn cannot be told from the next.
   */
  invocation: AbortSignal | undefined;
  /**
   * The call's number among the model calls this execution has started, taken when the
   * call starts rather than when it settles. Workflow code starts its calls in the same
   * order on every replay, so the number is deterministic.
   */
  seq: number;
}

/** A model call that failed and that ADK absorbed into an event instead of rethrowing. */
interface Recording extends ModelCall {
  /** The failure the `TemporalModel` call threw. */
  error: unknown;
}

/** What one inbound frame — the main function, a Signal handler, an Update handler — absorbed. */
interface Frame {
  /** Failures no caller has marked handled or superseded, in the order they were absorbed. */
  pending: Recording[];
  /**
   * The frame's first absorbed cancellation, held apart from `pending`: whether it is
   * the execution's outcome is only knowable once the frame returns, and it outranks
   * anything else the frame absorbed.
   */
  cancellation?: unknown;
  /** Whether the frame has returned, spending its one chance to raise; it never takes another. */
  surfaced: boolean;
}

interface AbsorbedFailures {
  /** The frame the running code belongs to. */
  frames: ALS<Frame>;
  /** The main function's frame, which owns whatever is absorbed outside a handler frame. */
  main?: Frame;
  /** How many model calls the execution has started: the latest call's `seq`. */
  calls: number;
  /**
   * The `seq` of each agent's latest answered call, per ADK invocation. Held apart from the
   * frames, because a call can settle after the frame that started it has returned.
   */
  answered: WeakMap<AbortSignal, Map<string, number>>;
}

function recorded(): AbsorbedFailures {
  const global = globalThis as Record<string, unknown>;
  let state = global[ABSORBED] as AbsorbedFailures | undefined;
  if (state === undefined) {
    state = { frames: new AsyncLocalStorage<Frame>(), calls: 0, answered: new WeakMap() };
    global[ABSORBED] = state;
  }
  return state;
}

function openFrame(): Frame | undefined {
  const { frames, main } = recorded();
  const frame = frames.getStore() ?? main;
  if (frame?.surfaced === false) return frame;
  // A surfaced frame is never read again; only the main function's can still raise a failure.
  return main?.surfaced === false ? main : undefined;
}

/**
 * Numbers a `TemporalModel` call as it starts, so that how it ends can be ordered against
 * the same agent's other calls (see {@link recordModelSuccess}).
 *
 * @internal
 */
export function startModelCall(agent: string, invocation: AbortSignal | undefined): ModelCall {
  const state = recorded();
  state.calls += 1;
  return { agent, invocation, seq: state.calls };
}

/**
 * Whether the same agent has answered in the same invocation through a call that started
 * after `call`. Then `call` belongs to an attempt ADK has already moved past: a call is
 * left running that way by ADK's own node `timeout`, which abandons the timed-out attempt
 * without cancelling its model call (`node_runner.ts`) while a retry answers.
 *
 * The key is the one {@link recordModelSuccess} spends by, so one agent run side by side
 * over several items (a `ParallelWorker`) is one agent here: an item that answered hides
 * the failure of an item whose call started earlier, and the run then fails on ADK's own
 * report of that item (`NodeReportedError`) rather than on the model failure.
 */
function superseded(call: ModelCall): boolean {
  if (call.invocation === undefined) return false;
  const answered = recorded().answered.get(call.invocation)?.get(call.agent);
  return answered !== undefined && answered > call.seq;
}

/**
 * Records how a failed `TemporalModel` call ended, unless the failure is one ADK has
 * already moved past ({@link superseded}): a call left running by a timed-out attempt
 * whose retry answered first says nothing about the run, however it ends later.
 *
 * @internal
 */
export function recordAbsorbedFailure(err: unknown, call: ModelCall): void {
  if (superseded(call)) return;
  const frame = openFrame();
  if (frame === undefined) return;
  if (isCancellation(err)) {
    frame.cancellation ??= err;
  } else {
    frame.pending.push({ ...call, error: err });
  }
}

/**
 * Declares that a `TemporalModel` call succeeded, which spends whatever the same agent
 * absorbed in the same ADK invocation through a call that started before this one: that is
 * ADK having retried the node (or activated it again) and got its answer, and a run
 * finishing normally must not fail on the attempt it recovered from. Ordering by when the
 * calls started, not by when they ended, also covers an earlier call still running when
 * the answer comes: its failure is not recorded at all, whenever it arrives.
 *
 * Both halves of the key matter. A sibling agent answering says nothing about this one's
 * failure, and a later *turn* by the same agent is a new question, not a second go at the
 * one that failed — which is why a call with no invocation to compare (a plain agent turn
 * outside a graph, where ADK sets no signal) never clears anything. Nor does an answer
 * spend the failure of a call that started after it.
 *
 * @internal
 */
export function recordModelSuccess(call: ModelCall): void {
  const { agent, invocation, seq } = call;
  if (invocation === undefined) return;
  const { answered } = recorded();
  let latest = answered.get(invocation);
  if (latest === undefined) {
    latest = new Map();
    answered.set(invocation, latest);
  }
  latest.set(agent, Math.max(latest.get(agent) ?? 0, seq));
  const frame = openFrame();
  if (frame === undefined) return;
  frame.pending = frame.pending.filter(
    (recording) => recording.agent !== agent || recording.invocation !== invocation || recording.seq > seq
  );
}

/**
 * Declares that the caller handled `error` from a failed `TemporalModel` call, so it must
 * not fail the Workflow or reject the Update it happened in. Other failures absorbed by the
 * same Workflow invocation — the main function, or the Signal or Update handler that ran
 * the turn — still surface. Does nothing outside a Workflow.
 *
 * Call it from an ADK `onModelErrorCallback`, passing the `error` that callback received,
 * and return the substitute response from that callback — built with ADK's `createEvent`,
 * because ADK yields the callback's return value untouched and `isFinalResponse` then
 * dereferences the `actions` a bare `LlmResponse` does not carry. ADK finishes the run on
 * the substitute, and without this call the Workflow fails anyway and the recovery is
 * discarded. A cancellation cannot be handled this way: an execution whose cancel a model
 * call absorbed still ends CANCELLED.
 */
export function markModelFailureHandled(error: unknown): void {
  if (!inWorkflowContext()) return;
  const frame = openFrame();
  if (frame === undefined) return;
  const at = frame.pending.findIndex((recording) => recording.error === error);
  if (at !== -1) frame.pending.splice(at, 1);
}

function raiseAbsorbed(frame: Frame): void {
  // Only a cancel a model call absorbed lands here, and it decides the outcome only if
  // the execution itself was cancelled. An inner scope's cancel
  // (`CancellationScope.withTimeout`) is the consumer's own doing and is not raised at all.
  if (frame.cancellation !== undefined && CancellationScope.current().consideredCancelled) {
    // Re-raised as caught: CANCELLED is read off the original `ActivityFailure` /
    // `CancelledFailure` pair, which any wrapper would hide.
    throw frame.cancellation;
  }
  if (frame.pending.length > 0) throw frame.pending[0]!.error;
}

/**
 * The name of ADK's `NodeReportedError`: a graph node that ended without output because
 * the agent it ran absorbed an error. When that error was a `TemporalModel` call the frame
 * has it recorded, and the recording — an `ActivityFailure` carrying the model failure's
 * status and cause chain — is the better thing to raise.
 */
const NODE_REPORTED_ERROR = 'NodeReportedError';

/**
 * The name of ADK's `DynamicNodeFailError`: the carrier a dynamic node (`ctx.runNode`)
 * wraps whatever its child threw in, on `.error` rather than on `.cause`. A static node
 * rethrows its child's error as it is, so the wrapper is unwrapped here to keep the two
 * alike.
 */
const DYNAMIC_NODE_FAIL_ERROR = 'DynamicNodeFailError';

/**
 * Follows ADK's dynamic-node carriers down to the error a child actually raised. Nesting
 * one dynamic run inside another wraps the carrier again, and the outer ones say nothing
 * about what went wrong. `.error` is always an `Error` where ADK sets it; the guards make
 * a hand-built or cyclic carrier terminate rather than spin.
 */
function innermostNodeFailure(err: Error): Error {
  const seen = new Set<Error>([err]);
  let current = err;
  while (current.name === DYNAMIC_NODE_FAIL_ERROR) {
    const wrapped: unknown = (current as { error?: unknown }).error;
    if (!(wrapped instanceof Error) || seen.has(wrapped)) break;
    seen.add(wrapped);
    current = wrapped;
  }
  return current;
}

/**
 * Converts an ADK workflow-runtime error escaping a frame into the failure that should
 * end the execution. A dynamic node's carrier is unwrapped first, so the decision is the
 * one a static node would have produced: a Temporal failure the child raised is returned
 * as it is, an absorbed model call is re-raised from the frame's recording, and anything
 * else becomes a non-retryable `ApplicationFailure` typed per
 * {@link ADK_RUNTIME_FAILURE_TYPES} with the ADK error as its cause. A cancellation the
 * frame recorded outranks all of that once the execution itself is cancelled. Anything the
 * map does not name — a `TemporalFailure`, a user's own error — is returned unchanged.
 */
function toWorkflowFailure(err: unknown, frame: Frame): unknown {
  if (!(err instanceof Error)) return err;
  const type = ADK_RUNTIME_FAILURE_TYPES[err.name];
  if (type === undefined) return err;
  // A model call that a cancel ended was recorded apart from the failures, and ADK then
  // absorbed it like any model error and reported the node as failed (`NodeReportedError`,
  // possibly inside a dynamic run's carrier). When the execution itself was cancelled,
  // the recorded cancellation is the outcome, by the same rule `raiseAbsorbed` applies on
  // a normal return; converting ADK's report would end a cancelled execution FAILED.
  if (frame.cancellation !== undefined && CancellationScope.current().consideredCancelled) {
    return frame.cancellation;
  }
  const cause = innermostNodeFailure(err);
  // A Temporal failure the child raised is what must end the execution: a cancelled
  // Activity has to end it CANCELLED rather than FAILED, and a failed one keeps the
  // cause chain (status, retry state) that the carrier would hide.
  if (cause instanceof TemporalFailure) return cause;
  if (cause.name === NODE_REPORTED_ERROR && frame.pending.length > 0) return frame.pending[0]!.error;
  // The innermost error names the failure; the carrier's own type is the fallback for a
  // child error the map does not know.
  return ApplicationFailure.create({
    message: cause.message,
    type: ADK_RUNTIME_FAILURE_TYPES[cause.name] ?? type,
    nonRetryable: true,
    cause,
  });
}

async function surfaceAbsorbedFailure<T>(frame: Frame, next: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await recorded().frames.run(frame, next);
  } catch (err) {
    // `continueAsNew()` ends the run without surfacing what was absorbed, so the chain
    // would reach a successful terminal state; it ends the execution wherever it is called
    // from, so the main function's failures count too.
    if (err instanceof ContinueAsNew) {
      raiseAbsorbed(frame);
      const { main } = recorded();
      if (main !== undefined && main !== frame) raiseAbsorbed(main);
    }
    throw toWorkflowFailure(err, frame);
  } finally {
    frame.surfaced = true;
  }
  raiseAbsorbed(frame);
  return result;
}

// ts-prune-ignore-next (loaded by path from workflowInterceptorModules)
export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [
    {
      execute: (input, next) => {
        const frame: Frame = { pending: [], surfaced: false };
        recorded().main = frame;
        return surfaceAbsorbedFailure(frame, () => next(input));
      },
      handleUpdate: (input, next) => surfaceAbsorbedFailure({ pending: [], surfaced: false }, () => next(input)),
      handleSignal: (input, next) => surfaceAbsorbedFailure({ pending: [], surfaced: false }, () => next(input)),
    },
  ],
});
