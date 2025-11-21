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
 * 2. Pass the context's {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} at
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

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Logger,
  Duration,
  LogLevel,
  LogMetadata,
  MetricMeter,
  Priority,
  ActivityCancellationDetails,
  IllegalStateError,
  RetryPolicy,
} from '@temporalio/common';
import { msToNumber } from '@temporalio/common/lib/time';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import { ActivityCancellationDetailsHolder } from '@temporalio/common/lib/activity-cancellation-details';
import { Client } from '@temporalio/client';

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
 * ```ts
 *import { CompleteAsyncError } from '@temporalio/activity';
 *
 *export async function myActivity(): Promise<never> {
 *  // ...
 *  throw new CompleteAsyncError();
 *}
 * ```
 */
@SymbolBasedInstanceOfError('CompleteAsyncError')
export class CompleteAsyncError extends Error {}

// Make it safe to use @temporalio/activity with multiple versions installed.
const asyncLocalStorageSymbol = Symbol.for('__temporal_activity_context_storage__');
if (!(globalThis as any)[asyncLocalStorageSymbol]) {
  (globalThis as any)[asyncLocalStorageSymbol] = new AsyncLocalStorage<Context>();
}

export const asyncLocalStorage: AsyncLocalStorage<Context> = (globalThis as any)[asyncLocalStorageSymbol];

/**
 * Holds information about the current Activity Execution. Retrieved inside an Activity with `Context.current().info`.
 */
export interface Info {
  readonly taskToken: Uint8Array;
  /**
   * Base64 encoded `taskToken`
   */
  readonly base64TaskToken: string;
  readonly activityId: string;
  /**
   * Exposed Activity function name
   */
  readonly activityType: string;
  /**
   * The namespace this Activity is running in
   */
  readonly activityNamespace: string;
  /**
   * Attempt number for this activity. Starts at 1 and increments for every retry.
   */
  readonly attempt: number;
  /**
   * Whether this activity is scheduled in local or remote mode
   */
  readonly isLocal: boolean;
  /**
   * Information about the Workflow that scheduled the Activity
   */
  readonly workflowExecution: {
    readonly workflowId: string;
    readonly runId: string;
  };
  /**
   * The namespace of the Workflow that scheduled this Activity
   */
  readonly workflowNamespace: string;
  /**
   * The module name of the Workflow that scheduled this Activity
   */
  readonly workflowType: string;
  /**
   * Timestamp for when this Activity was first scheduled.
   * For retries, this will have the timestamp of the first attempt.
   * See {@link currentAttemptScheduledTimestampMs} for current attempt.
   *
   * @format number of milliseconds from epoch
   */
  readonly scheduledTimestampMs: number;
  /**
   * Timeout for this Activity from schedule to close.
   *
   * @format number of milliseconds
   */
  readonly scheduleToCloseTimeoutMs: number;
  /**
   * Timeout for this Activity from start to close.
   *
   * @format number of milliseconds
   */
  readonly startToCloseTimeoutMs: number;
  /**
   * Timestamp for when the current attempt of this Activity was scheduled.
   *
   * @format number of milliseconds from epoch
   */
  readonly currentAttemptScheduledTimestampMs: number;
  /**
   * Heartbeat timeout.
   * If this timeout is defined, the Activity must heartbeat before the timeout is reached.
   * The Activity must **not** heartbeat in case this timeout is not defined.
   *
   * @format number of milliseconds
   */
  readonly heartbeatTimeoutMs?: number;
  /**
   * The {@link Context.heartbeat | details} from the last recorded heartbeat from the last attempt of this Activity.
   *
   * Use this to resume your Activity from a checkpoint.
   */
  readonly heartbeatDetails: any;

  /**
   * Task Queue the Activity is scheduled in.
   *
   * For Local Activities, this is set to the Workflow's Task Queue.
   */
  readonly taskQueue: string;
  /**
   * Priority of this activity
   */
  readonly priority?: Priority;
  /**
   * The retry policy of this activity.
   *
   * Note that the server may have set a different policy than the one provided when scheduling the activity.
   * If the value is undefined, it means the server didn't send information about retry policy (e.g. due to old server
   * version), but it may still be defined server-side.
   */
  readonly retryPolicy?: RetryPolicy;
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
   * Gets the context of the current Activity.
   *
   * Uses {@link https://nodejs.org/docs/latest-v16.x/api/async_context.html#class-asynclocalstorage | AsyncLocalStorage} under the hood to make it accessible in nested callbacks and promises.
   */
  public static current(): Context {
    const store = asyncLocalStorage.getStore();
    if (store === undefined) {
      throw new Error('Activity context not initialized');
    }
    return store;
  }

  /**
   * **Not** meant to instantiated by Activity code, used by the worker.
   *
   * @ignore
   */
  constructor(
    /**
     * Holds information about the current executing Activity.
     */
    public readonly info: Info,

    /**
     * A Promise that fails with a {@link CancelledFailure} when cancellation of this activity is requested. The promise
     * is guaranteed to never successfully resolve. Await this promise in an Activity to get notified of cancellation.
     *
     * Note that to get notified of cancellation, an activity must _also_ {@link Context.heartbeat}.
     *
     * @see [Cancellation](/api/namespaces/activity#cancellation)
     */
    public readonly cancelled: Promise<never>,

    /**
     * An {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} that can be used to react to
     * Activity cancellation.
     *
     * This can be passed in to libraries such as
     * {@link https://www.npmjs.com/package/node-fetch#request-cancellation-with-abortsignal | fetch} to abort an
     * in-progress request and
     * {@link https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options child_process}
     * to abort a child process, as well as other built-in node modules and modules found on npm.
     *
     * Note that to get notified of cancellation, an activity must _also_ {@link Context.heartbeat}.
     *
     * @see [Cancellation](/api/namespaces/activity#cancellation)
     */
    public readonly cancellationSignal: AbortSignal,

    /**
     * The heartbeat implementation, injected via the constructor.
     */
    protected readonly heartbeatFn: (details?: any) => void,

    /**
     * The Worker's client, passed down through Activity context.
     */
    protected readonly _client: Client | undefined,

    /**
     * The logger for this Activity.
     *
     * This defaults to the `Runtime`'s Logger (see {@link Runtime.logger}). Attributes from the current Activity context
     * are automatically included as metadata on every log entries. An extra `sdkComponent` metadata attribute is also
     * added, with value `activity`; this can be used for fine-grained filtering of log entries further downstream.
     *
     * To customize log attributes, register a {@link ActivityOutboundCallsInterceptor} that intercepts the
     * `getLogAttributes()` method.
     *
     * Modifying the context logger (eg. `context.log = myCustomLogger` or by an {@link ActivityInboundLogInterceptor}
     * with a custom logger as argument) is deprecated. Doing so will prevent automatic inclusion of custom log attributes
     * through the `getLogAttributes()` interceptor. To customize _where_ log messages are sent, set the
     * {@link Runtime.logger} property instead.
     */
    public log: Logger,

    /**
     * Get the metric meter for this activity with activity-specific tags.
     *
     * To add custom tags, register a {@link ActivityOutboundCallsInterceptor} that
     * intercepts the `getMetricTags()` method.
     */
    public readonly metricMeter: MetricMeter,

    /**
     * Holder object for activity cancellation details
     */
    protected readonly _cancellationDetails: ActivityCancellationDetailsHolder
  ) {}

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
   * The SDK automatically throttles heartbeat calls to the server with a duration of 80% of the specified activity
   * heartbeat timeout. Throttling behavior may be customized with the `{@link maxHeartbeatThrottleInterval | https://typescript.temporal.io/api/interfaces/worker.WorkerOptions#maxheartbeatthrottleinterval} and {@link defaultHeartbeatThrottleInterval | https://typescript.temporal.io/api/interfaces/worker.WorkerOptions#defaultheartbeatthrottleinterval} worker options.
   *
   * Activities must heartbeat in order to receive Cancellation (unless they're Local Activities, which don't need to).
   *
   * :warning: Cancellation is not propagated from this function, use {@link cancelled} or {@link cancellationSignal} to
   * subscribe to cancellation notifications.
   */
  public readonly heartbeat = (details?: unknown): void => {
    this.heartbeatFn(details);
  };

  /**
   * A Temporal Client, bound to the same Temporal Namespace as the Worker executing this Activity.
   *
   * May throw an {@link IllegalStateError} if the Activity is running inside a `MockActivityEnvironment`
   * that was created without a Client.
   *
   * @experimental Client support over `NativeConnection` is experimental. Error handling may be
   *               incomplete or different from what would be observed using a {@link Connection}
   *               instead. Client doesn't support cancellation through a Signal.
   */
  public get client(): Client {
    if (this._client === undefined) {
      throw new IllegalStateError(
        'No Client available. This may be a MockActivityEnvironment that was created without a Client.'
      );
    }
    return this._client;
  }

  /**
   * Helper function for sleeping in an Activity.
   * @param ms Sleep duration: number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @returns A Promise that either resolves when `ms` is reached or rejects when the Activity is cancelled
   */
  public readonly sleep = (ms: Duration): Promise<void> => {
    let handle: NodeJS.Timeout;
    const timer = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, msToNumber(ms));
    });
    return Promise.race([this.cancelled.finally(() => clearTimeout(handle)), timer]);
  };

  /**
   * Return the cancellation details for this activity, if any.
   * @returns an object with boolean properties that describes the reason for cancellation, or undefined if not cancelled.
   *
   * @experimental Activity cancellation details include usage of experimental features such as activity pause, and may be subject to change.
   */
  public get cancellationDetails(): ActivityCancellationDetails | undefined {
    return this._cancellationDetails.details;
  }
}

/**
 * The current Activity's context.
 */
export function activityInfo(): Info {
  // For consistency with workflow.workflowInfo(), we want activityInfo() to be a function, rather than a const object.
  return Context.current().info;
}

/**
 * The logger for this Activity.
 *
 * This is a shortcut for `Context.current().log` (see {@link Context.log}).
 */
export const log: Logger = {
  // Context.current().log may legitimately change during the lifetime of an Activity, so we can't
  // just initialize that field to the value of Context.current().log and move on. Hence this indirection.
  log(level: LogLevel, message: string, meta?: LogMetadata): any {
    return Context.current().log.log(level, message, meta);
  },
  trace(message: string, meta?: LogMetadata): any {
    return Context.current().log.trace(message, meta);
  },
  debug(message: string, meta?: LogMetadata): any {
    return Context.current().log.debug(message, meta);
  },
  info(message: string, meta?: LogMetadata): any {
    return Context.current().log.info(message, meta);
  },
  warn(message: string, meta?: LogMetadata): any {
    return Context.current().log.warn(message, meta);
  },
  error(message: string, meta?: LogMetadata): any {
    return Context.current().log.error(message, meta);
  },
};

/**
 * Helper function for sleeping in an Activity.
 *
 * This is a shortcut for `Context.current().sleep(ms)` (see {@link Context.sleep}).
 *
 * @param ms Sleep duration: number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
 * @returns A Promise that either resolves when `ms` is reached or rejects when the Activity is cancelled
 */
export function sleep(ms: Duration): Promise<void> {
  return Context.current().sleep(ms);
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
 * This is a shortcut for `Context.current().heatbeat(ms)` (see {@link Context.heartbeat}).
 */
export function heartbeat(details?: unknown): void {
  Context.current().heartbeat(details);
}

/**
 * Return a Promise that fails with a {@link CancelledFailure} when cancellation of this activity is requested. The
 * promise is guaranteed to never successfully resolve. Await this promise in an Activity to get notified of
 * cancellation.
 *
 * Note that to get notified of cancellation, an activity must _also_ do {@link Context.heartbeat}.
 *
 * This is a shortcut for `Context.current().cancelled` (see {@link Context.cancelled}).
 */
export function cancelled(): Promise<never> {
  return Context.current().cancelled;
}

/**
 * Return the cancellation details for this activity, if any.
 * @returns an object with boolean properties that describes the reason for cancellation, or undefined if not cancelled.
 *
 * @experimental Activity cancellation details include usage of experimental features such as activity pause, and may be subject to change.
 */
export function cancellationDetails(): ActivityCancellationDetails | undefined {
  return Context.current().cancellationDetails;
}

/**
 * Return an {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} that can be used to
 * react to Activity cancellation.
 *
 * This can be passed in to libraries such as
 * {@link https://www.npmjs.com/package/node-fetch#request-cancellation-with-abortsignal | fetch} to abort an
 * in-progress request and
 * {@link https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options child_process}
 * to abort a child process, as well as other built-in node modules and modules found on npm.
 *
 * Note that to get notified of cancellation, an activity must _also_ do {@link Context.heartbeat}.
 *
 * This is a shortcut for `Context.current().cancellationSignal` (see {@link Context.cancellationSignal}).
 */
export function cancellationSignal(): AbortSignal {
  return Context.current().cancellationSignal;
}

/**
 * A Temporal Client, bound to the same Temporal Namespace as the Worker executing this Activity.
 *
 * May throw an {@link IllegalStateError} if the Activity is running inside a `MockActivityEnvironment`
 * that was created without a Client.
 *
 * This is a shortcut for `Context.current().client` (see {@link Context.client}).
 *
 * @experimental Client support over `NativeConnection` is experimental. Error handling may be
 *               incomplete or different from what would be observed using a {@link Connection}
 *               instead. Client doesn't support cancellation through a Signal.
 */
export function getClient(): Client {
  return Context.current().client;
}

/**
 * Get the metric meter for the current activity, with activity-specific tags.
 *
 * To add custom tags, register a {@link ActivityOutboundCallsInterceptor} that
 * intercepts the `getMetricTags()` method.
 *
 * This is a shortcut for `Context.current().metricMeter` (see {@link Context.metricMeter}).
 */
export const metricMeter: MetricMeter = {
  createCounter(name, unit, description) {
    return Context.current().metricMeter.createCounter(name, unit, description);
  },
  createHistogram(name, valueType = 'int', unit, description) {
    return Context.current().metricMeter.createHistogram(name, valueType, unit, description);
  },
  createGauge(name, valueType = 'int', unit, description) {
    return Context.current().metricMeter.createGauge(name, valueType, unit, description);
  },
  withTags(tags) {
    return Context.current().metricMeter.withTags(tags);
  },
};
