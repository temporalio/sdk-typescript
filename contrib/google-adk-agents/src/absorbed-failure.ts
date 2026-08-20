/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
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
 */

import type { AsyncLocalStorage as ALS } from 'node:async_hooks';

import {
  AsyncLocalStorage,
  CancellationScope,
  ContinueAsNew,
  inWorkflowContext,
  isCancellation,
  type WorkflowInterceptorsFactory,
} from '@temporalio/workflow';

// Held on the per-execution sandbox `globalThis` rather than in module scope: a
// bundle can hold two copies of this module (the interceptor list registers its
// compiled path, while a Workflow reaches it through its own import of
// `TemporalModel`), and both have to reach the same recordings.
const ABSORBED = '__temporal_googleAdkAbsorbedFailures';

/** What one inbound frame — the main function, a Signal handler, an Update handler — absorbed. */
interface Frame {
  /** Failures no caller has marked handled, in the order they were absorbed. */
  pending: unknown[];
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
}

function recorded(): AbsorbedFailures {
  const global = globalThis as Record<string, unknown>;
  let state = global[ABSORBED] as AbsorbedFailures | undefined;
  if (state === undefined) {
    state = { frames: new AsyncLocalStorage<Frame>() };
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

/** @internal */
export function recordAbsorbedFailure(err: unknown): void {
  const frame = openFrame();
  if (frame === undefined) return;
  if (isCancellation(err)) {
    frame.cancellation ??= err;
  } else {
    frame.pending.push(err);
  }
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
  const at = frame.pending.indexOf(error);
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
  if (frame.pending.length > 0) throw frame.pending[0];
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
    throw err;
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
