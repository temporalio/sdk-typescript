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
