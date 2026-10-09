/**
 * Links ADK's abort signal to the Activity calls the plugin makes on ADK's behalf.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph. It must
 * not import any worker-only module.
 */

import { CancellationScope } from '@temporalio/workflow';

/**
 * Runs an Activity call in a cancellable `CancellationScope` that ADK's abort signal
 * cancels, so an ADK abort reaches the Activity as an ordinary, replay-safe cancellation.
 * Used by every Activity call ADK waits on: a `TemporalModel` call, an `activityAsTool`
 * call and a `TemporalMCPToolset` tool call.
 *
 * Inside a `Workflow` graph the signal is the run's own, shared by every node
 * (`InvocationContext.abortSignal`): a model call receives it as `generateContentAsync`'s
 * `abortSignal`, and a tool call as `toolContext.abortSignal`, which ADK's `Context`
 * copies from the same invocation context. ADK aborts it when a sibling node fails, then
 * waits for every outstanding node before failing the run (`Workflow.cleanupPending`), and
 * a node cannot unwind while it is still waiting on an Activity: without the cancel, the
 * call would hold the run until the Activity ended on its own, retries included.
 * Cancelled, the call fails as any cancelled Activity call does (an `ActivityFailure` whose
 * cause is the `CancelledFailure`, or the scope's `CancelledFailure` when the signal had
 * already aborted, in which case nothing is scheduled). When the cancel counts as settled
 * is the Activity's `cancellationType`.
 *
 * The listener is removed once the call settles, because the signal outlives it, and it
 * never throws: it runs inside a host `EventTarget` dispatch, outside the Workflow's own
 * error handling. Without a signal (a plain agent turn) the call runs as it is.
 *
 * @internal
 */
export async function underAbortSignal<T>(signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
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
