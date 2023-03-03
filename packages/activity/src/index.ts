/**
 * This package's main export is {@link Context}. Get the current Activity's context with
 * {@link Context.current | `Context.current()`}:
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
 * {@link https://docs.temporal.io/concepts/what-is-a-data-converter/ | DataConverter}.
 *
 * ### Cancellation
 *
 * Activity Cancellation:
 *
 * - lets the Activity know it doesn't need to keep doing work, and
 * - gives the Activity time to clean up any resources it has created.
 *
 * Activities can only receive Cancellation if they {@link Context.heartbeat | emit heartbeats} or are Local Activities
 * (which can't heartbeat but receive Cancellation anyway).
 *
 * An Activity may receive Cancellation if:
 *
 * - The Workflow scope containing the Activity call was requested to be Cancelled and
 *   {@link ActivityOptions.cancellationType} was **not** set to {@link ActivityCancellationType.ABANDON}. The scope can
 *   be cancelled in either of the following ways:
 *   - The entire Workflow was Cancelled (via {@link WorkflowHandle.cancel}).
 *   - Calling {@link CancellationScope.cancel}) from inside a Workflow.
 * - The Worker has started to shut down. Shutdown is initiated by either:
 *   - One of the {@link RuntimeOptions.shutdownSignals} was sent to the process.
 *   - {@link Worker.shutdown | `Worker.shutdown()`} was called.
 * - The Activity was considered failed by the Server because any of the Activity timeouts have triggered (for example,
 *   the Server didn't receive a heartbeat within the {@link ActivityOptions.heartbeatTimeout}). The
 *   {@link CancelledFailure} will have `message: 'TIMED_OUT'`.
 * - An Activity sends a heartbeat with `Context.current().heartbeat()` and the heartbeat details can't be converted by
 *   the Worker's configured {@link DataConverter}.
 * - The Workflow Run reached a {@link https://docs.temporal.io/workflows#status | Closed state}, in which case the
 *   {@link CancelledFailure} will have `message: 'NOT_FOUND'`.
 *
 * The reason for the Cancellation is available at {@link CancelledFailure.message} or
 * {@link Context#cancellationSignal | Context.cancellationSignal.reason}.
 *
 * Activity implementations should opt-in and subscribe to cancellation using one of the following methods:
 *
 * 1. `await` on {@link Context.cancelled | `Context.current().cancelled`} or
 *    {@link Context.sleep | `Context.current().sleep()`}, which each throw a {@link CancelledFailure}.
 * 1. Pass the context's {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} at
 *    {@link Context.cancellationSignal | `Context.current().cancellationSignal`} to a library that supports it.
 *
 * ### Examples
 *
 * #### An Activity that sends progress heartbeats and can be Cancelled
 *
 * <!--SNIPSTART typescript-activity-fake-progress-->
 * <!--SNIPEND-->
 *
 * #### An Activity that makes a cancellable HTTP request
 *
 * It passes the `AbortSignal` to {@link https://github.com/node-fetch/node-fetch#api | `fetch`}: `fetch(url, { signal:
 * Context.current().cancellationSignal })`.
 *
 * <!--SNIPSTART typescript-activity-cancellable-fetch-->
 * <!--SNIPEND-->
 *
 * @module
 */

import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { AsyncLocalStorage } from 'node:async_hooks';
import { msToNumber } from '@temporalio/common/lib/time';

export {
  ActivityFunction,
  ActivityInterface, // eslint-disable-line deprecation/deprecation
  ApplicationFailure,
  CancelledFailure,
  UntypedActivities,
} from '@temporalio/common';

/**
 * Throw this error from an Activity in order to make the Worker forget about this Activity.
 *
 * The Activity can then be completed asynchronously (from anywhere—usually outside the Worker) using
 * {@link Client.activity}.
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
   * The {@link Context.heartbeat | details} from the last recorded heartbeat from the last attempt of this Activity.
   *
   * Use this to resume your Activity from a checkpoint.
   */
  heartbeatDetails: any;

  /**
   * Task Queue the Activity is scheduled in.
   *
   * For Local Activities, this is set to the Workflow's Task Queue.
   */
  taskQueue: string;
}

/**
 * Activity Context, used to:
 *
 * - Get {@link Info} about the current Activity Execution
 * - Send {@link https://docs.temporal.io/concepts/what-is-an-activity-heartbeat | heartbeats}
 * - Get notified of Activity cancellation
 * - Sleep (cancellation-aware)
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
   * @see [Cancellation](/api/namespaces/activity#cancellation)
   */
  public readonly cancelled: Promise<never>;
  /**
   * An {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} that can be used to react to
   * Activity cancellation.
   *
   * Used by {@link https://www.npmjs.com/package/node-fetch#request-cancellation-with-abortsignal | fetch} to abort an
   * in-progress request and
   * {@link https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options child_process}
   * to abort a child process, and is supported by some other libraries as well.
   *
   * @see [Cancellation](/api/namespaces/activity#cancellation)
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
   * Send a {@link https://docs.temporal.io/concepts/what-is-an-activity-heartbeat | heartbeat} from an Activity.
   *
   * If an Activity times out, then during the next retry, the last value of `details` is available at
   * {@link Info.heartbeatDetails}. This acts as a periodic checkpoint mechanism for the progress of an Activity.
   *
   * If an Activity times out on the final retry (relevant in cases in which {@link RetryPolicy.maximumAttempts} is
   * set), the Activity function call in the Workflow code will throw an {@link ActivityFailure} with the `cause`
   * attribute set to a {@link TimeoutFailure}, which has the last value of `details` available at
   * {@link TimeoutFailure.lastHeartbeatDetails}.
   *
   * Calling `heartbeat()` from a Local Activity has no effect.
   *
   * Activities must heartbeat in order to receive Cancellation (unless they're Local Activities, which don't need to).
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
   * @param ms Sleep duration: number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
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
