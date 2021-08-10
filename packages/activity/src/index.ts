/**
 * This library provides tools for authoring activities.
 *
 * Import this module from Activity code - must **not** be used in Workflows.
 *
 * Any function can be used as an Activity as long as its parameters and return value are serialiable using a [`DataConverter`](../interfaces/worker.dataconverter.md).
 *
 * ### Cancellation
 * Activities may be cancelled only if they [emit heartbeats](../classes/activity.context.md#heartbeat).<br/>
 * There are 2 ways to handle Activity cancellation:
 * 1. await on [`Context.current().cancelled`](../classes/activity.context.md#cancelled)
 * 1. Pass the context's [abort signal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) at [`Context.current().cancellationSignal`](../classes/activity.context.md#cancellationsignal) to a library that supports it
 *
 * ### Examples
 *
 * #### An Activity that fakes progress and can be cancelled
 *
 * <!--SNIPSTART nodejs-activity-fake-progress-->
 * <!--SNIPEND-->
 *
 * #### An Activity that makes a cancellable HTTP request
 * ```ts
 * import fetch from 'node-fetch';
 * import { Context } from '@temporalio/activity';
 *
 * export async function cancellableFetch(url: string): Promise<Uint8Array> {
 *   const response = await fetch(url, { signal: Context.current().cancellationSignal });
 *   const contentLengthHeader = response.headers.get('Content-Length');
 *   if (contentLengthHeader === null) {
 *     throw new Error('expected Content-Length header to be set');
 *   }
 *   const contentLength = parseInt(contentLengthHeader);
 *   let bytesRead = 0;
 *   const chunks: Buffer[] = [];

 *   for await (const chunk of response.body) {
 *     if (!(chunk instanceof Buffer)) {
 *       throw new TypeError('Expected Buffer');
 *     }
 *     bytesRead += chunk.length;
 *     chunks.push(chunk);
 *     Context.current().heartbeat(bytesRead / contentLength);
 *   }
 *   return Buffer.concat(chunks);
 * }
 * ```
 * @module
 */

import { AsyncLocalStorage } from 'async_hooks';
import { AbortSignal } from 'abort-controller';

/** @ignore */
export const asyncLocalStorage = new AsyncLocalStorage<Context>();

/**
 * Holds information about the current executing Activity
 */
export interface Info {
  taskToken: Uint8Array;
  activityId: string;
  /**
   * Tuple containing the Activity module name and function name
   */
  activityType: [string, string];
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
   * Timeout for this Activity from schedule to close in milliseconds
   */
  scheduleToCloseTimeoutMs: number;
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
 * Activity Context manager.
 *
 * Call `Context.current()` from Activity code in order to send heartbeats and get notified of Activity cancellation.
 */
export class Context {
  /**
   * Holds information about the current executing Activity
   */
  public info: Info;
  protected cancel: (reason?: any) => void = () => undefined;
  /**
   * Await this promise in an Activity to get notified of cancellation.
   *
   * This promise will never be resolved, it will only be rejected with a {@link CancelledFailure}.
   */
  public readonly cancelled: Promise<never>;
  /**
   * An `AbortSignal` which can be used to cancel requests on Activity cancellation.
   *
   * Typically used by the {@link https://www.npmjs.com/package/node-fetch#request-cancellation-with-abortsignal | fetch} and {@link https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options child_process} libraries but is supported by a few other libraries as well.
   */
  public readonly cancellationSignal: AbortSignal;
  /**
   * Send a heartbeat from an Activity.
   *
   * If an Activity times out, the last value of details is included in the ActivityTimeoutException delivered to a Workflow. Then the Workflow can pass the details to the next Activity invocation. This acts as a periodic checkpoint mechanism for the progress of an Activity.
   *
   * The Activity must heartbeat in order to receive cancellation.
   */
  public readonly heartbeat: (details?: any) => void;

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
    this.heartbeat = heartbeat;
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
   * @param ms duration in milliseconds
   * @returns a Promise that either resolves when deadline is reached or rejects when the Context is cancelled
   */
  public sleep(ms: number): Promise<void> {
    let handle: NodeJS.Timeout;
    const timer = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return Promise.race([this.cancelled.finally(() => clearTimeout(handle)), timer]);
  }
}
