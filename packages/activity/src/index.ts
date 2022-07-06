/**
 * This package's main export is [`Context`](../classes/activity.Context). Get the current Activity's context with
 * `Context.current()`:
 *
 * ```ts
 * import { Context } from '@temporalio/activity';
 *
 * export async function myActivity() {
 *   const context = Context.current();
 * }
 * ```
 *
 * Any function can be used as an Activity as long as its parameters and return value are serializable using a
 * [DataConverter](https://docs.temporal.io/concepts/what-is-a-data-converter/).
 *
 * ### Cancellation
 *
 * Activities may be cancelled only if they [emit heartbeats](../classes/activity.Context.md#heartbeat).
 *
 * There are two ways to handle Activity cancellation:
 * 1. await on [`Context.current().cancelled`](../classes/activity.Context.md#cancelled) or
 *    [`Context.current().sleep()`](../classes/activity.Context.md#sleep), which each throw a
 *    [`CancelledFailure`](../classes/client.CancelledFailure)
 * 1. Pass the context's [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) at
 *    [`Context.current().cancellationSignal`](../classes/activity.Context.md#cancellationsignal) to a library that
 *    supports it
 *
 * ### Examples
 *
 * #### An Activity that sends progress heartbeats and can be cancelled
 *
 * <!--SNIPSTART typescript-activity-fake-progress-->
 * <!--SNIPEND-->
 *
 * #### An Activity that makes a cancellable HTTP request
 *
 * It passes the `AbortSignal` to [`fetch`](https://github.com/node-fetch/node-fetch#api): `fetch(url, { signal:
 * Context.current().cancellationSignal })`.
 *
 * <!--SNIPSTART typescript-activity-cancellable-fetch-->
 * <!--SNIPEND-->
 *
 * @module
 */

import { msToNumber } from '@temporalio/internal-workflow-common';
import { AbortSignal } from 'abort-controller';
import { AsyncLocalStorage } from 'async_hooks';
export { CancelledFailure } from '@temporalio/common';
export { ActivityFunction, ActivityInterface } from '@temporalio/internal-workflow-common';
export * from '@temporalio/internal-workflow-common/lib/errors';

/**
 * Throw this error from an Activity in order to make the Worker forget about this Activity.
 *
 * The Activity can then be completed asynchronously (from anywhere—usually outside the Worker) using
 * {@link AsyncCompletionClient}.
 *
 * @example
 *
 *```ts
 *import { CompleteAsyncError } from '@temporalio/activity';
 *
 *export async function myActivity(): Promise<never> {
 *  // ...
 *  throw new CompleteAsyncError();
 *}
 *```
 */
export class CompleteAsyncError extends Error {
  public readonly name: string = 'CompleteAsyncError';

  constructor() {
    super();
  }
}

/** @ignore */
export const asyncLocalStorage = new AsyncLocalStorage<Context>();

/**
 * Holds information about the current Activity Execution. Retrieved inside an Activity with `Context.current().info`.
 */
export interface Info {
  taskToken: Uint8Array;
  /**
   * Base64 encoded `taskToken`
   */
  base64TaskToken: string;
  activityId: string;
  /**
   * Exposed Activity function name
   */
  activityType: string;
  /**
   * The namespace this Activity is running in
   */
  activityNamespace: string;
  /**
   * Attempt number for this activity
   */
  attempt: number;
  /**
   * Whether this activity is scheduled in local or remote mode
   */
  isLocal: boolean;
  /**
   * Information about the Workflow that scheduled the Activity
   */
  workflowExecution: {
    workflowId: string;
    runId: string;
  };
  /**
   * The namespace of the Workflow that scheduled this Activity
   */
  workflowNamespace: string;
  /**
   * The module name of the Workflow that scheduled this Activity
   */
  workflowType: string;
  /**
   * Timestamp for when this Activity was scheduled in milliseconds
   */
  scheduledTimestampMs: number;
  /**
   * Timeout for this Activity from schedule to close in milliseconds.
   *
   * Might be undefined for local activities.
   */
  scheduleToCloseTimeoutMs?: number;
  /**
   * Timeout for this Activity from start to close in milliseconds
   */
  startToCloseTimeoutMs: number;
  /**
   * Heartbeat timeout in milliseconds.
   * If this timeout is defined, the Activity must heartbeat before the timeout is reached.
   * The Activity must **not** heartbeat in case this timeout is not defined.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Hold the details supplied to the last heartbeat on previous attempts of this Activity.
   * Use this in order to resume your Activity from checkpoint.
   */
  heartbeatDetails: any;
}

/**
 * Activity Context, used to:
 *
 * - Get {@link Info} about the current Activity Execution
 * - Send [heartbeats](https://docs.temporal.io/concepts/what-is-an-activity-heartbeat)
 * - Get notified of Activity cancellation
 * - Sleep
 *
 * Call `Context.current()` from Activity code in order to get the current Activity's Context.
 */
export class Context {
  /**
   * Holds information about the current executing Activity.
   */
  public info: Info;
  /**
   * Await this promise in an Activity to get notified of cancellation.
   *
   * This promise will never resolve—it will only be rejected with a {@link CancelledFailure}.
   *
   * See: [Cancellation](/api/namespaces/activity#cancellation)
   */
  public readonly cancelled: Promise<never>;
  /**
   * An [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) that can be used to react to
   * Activity cancellation.
   *
   * Used by {@link https://www.npmjs.com/package/node-fetch#request-cancellation-with-abortsignal | fetch} to abort an
   * in-progress request and
   * {@link https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options child_process}
   * to abort a child process, and is supported by some other libraries as well.
   *
   * See: [Cancellation](/api/namespaces/activity#cancellation)
   */
  public readonly cancellationSignal: AbortSignal;
  /**
   * The heartbeat implementation, injected via the constructor.
   */
  protected readonly heartbeatFn: (details?: any) => void;

  /**
   * **Not** meant to instantiated by Activity code, used by the worker.
   *
   * @ignore
   */
  constructor(
    info: Info,
    cancelled: Promise<never>,
    cancellationSignal: AbortSignal,
    heartbeat: (details?: any) => void
  ) {
    this.info = info;
    this.cancelled = cancelled;
    this.cancellationSignal = cancellationSignal;
    this.heartbeatFn = heartbeat;
  }

  /**
   * Send a [heartbeat](https://docs.temporal.io/concepts/what-is-an-activity-heartbeat) from an Activity.
   *
   * If an Activity times out, then during the next retry, the last value of `details` is available at
   * {@link Info.heartbeatDetails}. This acts as a periodic checkpoint mechanism for the progress of an Activity.
   *
   * If an Activity times out on the final retry (relevant in cases in which {@link RetryPolicy.maximumAttempts} is
   * set), the Activity function call in the Workflow code will throw an {@link ActivityFailure} with the `cause`
   * attribute set to a {@link TimeoutFailure}, which has the last value of `details` available at
   * {@link TimeoutFailure.lastHeartbeatDetails}.
   *
   * Activities must heartbeat in order to receive cancellation.
   */
  public heartbeat(details?: unknown): void {
    this.heartbeatFn(details);
  }

  /**
   * Gets the context of the current Activity.
   *
   * Uses {@link https://nodejs.org/docs/latest-v14.x/api/async_hooks.html#async_hooks_class_asynclocalstorage | AsyncLocalStorage} under the hood to make it accessible in nested callbacks and promises.
   */
  public static current(): Context {
    const store = asyncLocalStorage.getStore();
    if (store === undefined) {
      throw new Error('Activity context not initialized');
    }
    return store;
  }

  /**
   * Helper function for sleeping in an Activity.
   * @param ms Sleep duration: an {@link https://www.npmjs.com/package/ms | ms}-formatted string or number of milliseconds
   * @returns A Promise that either resolves when `ms` is reached or rejects when the Activity is cancelled
   */
  public sleep(ms: number | string): Promise<void> {
    let handle: NodeJS.Timeout;
    const timer = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, msToNumber(ms));
    });
    return Promise.race([this.cancelled.finally(() => clearTimeout(handle)), timer]);
  }
}
