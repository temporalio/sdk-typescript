/**
 * Library for authoring activities.
 *
 * Import this module from activity code - must **not** be used in workflows.
 *
 * Any function can be used as an activity as long as its parameters and return value are serialiable using a [`DataConverter`](../interfaces/worker.dataconverter.md).
 *
 * ### Cancellation
 * Activities may be cancelled only if they [emit heartbeats](../classes/activity.context.md#heartbeat).<br/>
 * There are 2 ways to handle activity cancellation:
 * 1. await on [`Context.current().cancelled`](../classes/activity.context.md#cancelled)
 * 1. Pass the context's [abort signal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) at [`Context.current().cancellationSignal`](../classes/activity.context.md#cancellationsignal) to a library that supports it
 *
 * ### Examples
 *
 * #### An activity that fakes progress and can be cancelled
 * ```ts
 * import { Context, CancellationError } from '@temporalio/activity';
 *
 * export async function fakeProgress(): Promise<void> {
 *   try {
 *     for (let progress = 1; progress <= 100; ++progress) {
 *       const timer = new Promise((resolve) => setTimeout(resolve, 1000));
 *       // sleep for 1 second or throw if activity is cancelled
 *       await Promise.race([Context.current().cancelled, timer]);
 *       Context.current().heartbeat(progress);
 *     }
 *   } catch (err) {
 *     if (err instanceof CancellationError) {
 *       // Cleanup
 *     }
 *     throw err;
 *   }
 * }
 * ```
 *
 * #### An activity that makes a cancellable HTTP request
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

import { AbortSignal } from 'abort-controller';
import { asyncLocalStorage } from './internals';

/**
 * Thrown in an activity when the activity is cancelled while awaiting {@link Context.cancelled}.
 *
 * The activity must {@link Context.heartbeat | send heartbeats} in order to be cancellable.
 */
export class CancellationError extends Error {
  public readonly name: string = 'CancellationError';
}

/**
 * Activity Context manager.
 *
 * Call `Context.current()` from activity code in order to send heartbeats and get notified of activity cancellation.
 */
export class Context {
  protected cancel: (reason?: any) => void = () => undefined;
  /**
   * Await this promise in an activity to get notified of cancellation.
   *
   * This promise will never be resolved, it will only be rejected with a {@link CancellationError}.
   */
  public readonly cancelled: Promise<never>;
  /**
   * An `AbortSignal` which can be used to cancel requests on activity cancellation.
   *
   * Typically used by the {@link https://www.npmjs.com/package/node-fetch#request-cancellation-with-abortsignal | fetch} and {@link https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options child_process} libraries but is supported by a few other libraries as well.
   */
  public readonly cancellationSignal: AbortSignal;
  /**
   * Send a heartbeat from an activity.
   *
   * If an Activity times out, the last value of details is included in the ActivityTimeoutException delivered to a Workflow. Then the Workflow can pass the details to the next Activity invocation. This acts as a periodic checkpoint mechanism for the progress of an Activity.
   */
  public readonly heartbeat: (details: any) => void;

  /**
   * **Not** meant to instantiated by activity code, used by the worker.
   *
   * @ignore
   */
  constructor(cancelled: Promise<never>, cancellationSignal: AbortSignal, heartbeat: (details: any) => void) {
    this.cancelled = cancelled;
    this.cancellationSignal = cancellationSignal;
    this.heartbeat = heartbeat;
  }

  /**
   * Gets the context of the current activity.
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
}
