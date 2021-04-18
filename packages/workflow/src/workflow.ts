import { ActivityFunction, ActivityOptions, CancellationFunctionFactory, RemoteActivityOptions } from './interfaces';
import { state, currentScope, childScope, propagateCancellation } from './internals';
import { defaultDataConverter } from './converter/data-converter';
import { CancellationError } from './errors';
import { msToTs, msOptionalStrToTs } from './time';

/**
 * Asynchronous sleep.
 *
 * Schedules a timer on the Temporal service.
 * The returned promise is {@link cancel | cancellable}.
 *
 * @param ms milliseconds to sleep for
 */
export function sleep(ms: number): Promise<void> {
  const seq = state.nextSeq++;
  const cancellation: CancellationFunctionFactory = (reject) => (err) => {
    if (!state.completions.delete(seq)) {
      return; // Already resolved
    }
    state.commands.push({
      cancelTimer: {
        timerId: `${seq}`,
      },
    });
    reject(err);
  };

  return childScope(
    cancellation,
    cancellation,
    () =>
      new Promise((resolve, reject) => {
        state.completions.set(seq, {
          resolve,
          reject,
          scope: currentScope(),
        });
        state.commands.push({
          startTimer: {
            timerId: `${seq}`,
            startToFireTimeout: msToTs(ms),
          },
        });
      })
  );
}

export interface ActivityInfo {
  name: string;
  type: string;
}

export type InternalActivityFunction<P extends any[], R> = ActivityFunction<P, R> & ActivityInfo;

/**
 * @hidden
 */
export function validateActivityOptions(options: ActivityOptions): asserts options is RemoteActivityOptions {
  if (options.type === 'local') {
    throw new TypeError('local activity is not yet implemented');
  }

  if (
    options.scheduleToCloseTimeout === undefined &&
    (options.scheduleToStartTimeout === undefined || options.startToCloseTimeout === undefined)
  ) {
    throw new TypeError(
      'Required either scheduleToCloseTimeout or both scheduleToStartTimeout and startToCloseTimeout'
    );
  }
}

/**
 * @hidden
 */
export function scheduleActivity<R>(activityType: string, args: any[], options: ActivityOptions): Promise<R> {
  validateActivityOptions(options);
  const seq = state.nextSeq++;
  return childScope(
    () => (_err) => {
      state.commands.push({
        requestCancelActivity: {
          activityId: `${seq}`,
          // TODO: reason: err instanceof Error ? err.message : undefined,
        },
      });
    },
    (reject) => reject,
    () =>
      new Promise((resolve, reject) => {
        state.completions.set(seq, {
          resolve,
          reject,
          scope: currentScope(),
        });
        state.commands.push({
          scheduleActivity: {
            activityId: `${seq}`,
            activityType,
            arguments: defaultDataConverter.toPayloads(...args),
            retryPolicy: options.retry
              ? {
                  maximumAttempts: options.retry.maximumAttempts,
                  initialInterval: msOptionalStrToTs(options.retry.initialInterval),
                  maximumInterval: msOptionalStrToTs(options.retry.maximumInterval),
                  backoffCoefficient: options.retry.backoffCoefficient,
                  // TODO: nonRetryableErrorTypes
                }
              : undefined,
            taskQueue: options.taskQueue || state.taskQueue,
            heartbeatTimeout: msOptionalStrToTs(options.heartbeatTimeout),
            scheduleToCloseTimeout: msOptionalStrToTs(options.scheduleToCloseTimeout),
            startToCloseTimeout: msOptionalStrToTs(options.startToCloseTimeout),
            scheduleToStartTimeout: msOptionalStrToTs(options.scheduleToStartTimeout),
            namespace: options.namespace,
            // TODO: add header with interceptors
          },
        });
      })
  );
}

function activityInfo(activity: string | [string, string] | ActivityFunction<any, any>): ActivityInfo {
  if (typeof activity === 'string') {
    return { name: activity, type: activity };
  }
  if (activity instanceof Array) {
    return { name: activity[1], type: JSON.stringify(activity) };
  } else {
    return activity as InternalActivityFunction<any, any>;
  }
}

export class ContextImpl {
  /**
   * @protected
   */
  constructor() {
    // Does nothing just marks this as protected for documentation
  }
  /**
   * Configure an activity function with given {@link ActivityOptions}
   * Activities use the worker options's {@link WorkerOptions.activityDefaults | activityDefaults} unless configured otherwise.
   *
   * @typeparam P type of parameters of activity function, e.g `[string, string]` for `(a: string, b: string) => Promise<number>`
   * @typeparam R return type of activity function, e.g `number` for `(a: string, b: string) => Promise<number>`
   *
   * @param activity either an activity name if triggering an activity in another language, a tuple of [module, name] for untyped activities (e.g. ['@activities', 'greet']) or an imported activity function.
   * @param options partial {@link ActivityOptions} object, any attributes provided here override the provided activity's options
   *
   * @example
   * ```ts
   * import { Context } from '@temporalio/workflow';
   * import { httpGet } from '@activities';
   *
   * const httpGetWithCustomTimeout = Context.configure(httpGet, {
   *   type: 'remote',
   *   scheduleToCloseTimeout: '30 minutes',
   * });
   *
   * // Example of creating an activity from string
   * // Passing type parameters is optional, configured function will be untyped unless provided
   * const httpGetFromJava = Context.configure<[string, number], number>('SomeJavaMethod'); // Use worker activityDefaults when 2nd parameter is omitted
   *
   * export function main(): Promise<void> {
   *   const response = await httpGetWithCustomTimeout('http://example.com');
   *   // ...
   * }
   * ```
   */
  public configure<P extends any[], R>(
    activity: string | [string, string] | ActivityFunction<P, R>,
    options: ActivityOptions | undefined = state.activityDefaults
  ): ActivityFunction<P, R> {
    const { name, type } = activityInfo(activity);
    if (options === undefined) {
      throw new TypeError('options must be defined');
    }
    validateActivityOptions(options);
    // Wrap the function in an object so it gets the original function name
    const { [name]: fn } = {
      [name](...args: P) {
        return scheduleActivity<R>(type, args, options);
      },
    };
    const configured = fn as InternalActivityFunction<P, R>;
    Object.assign(configured, { type, options });
    return configured;
  }

  /**
   * Returns whether or not this workflow received a cancellation request.
   *
   * The workflow might still be running in case {@link CancellationError}s were caught.
   */
  public get cancelled(): boolean {
    return state.cancelled;
  }
}

/**
 * Holds context of current running workflow
 */
export const Context = new ContextImpl();

/**
 * Wraps Promise returned from `fn` with a cancellation scope.
 * The returned Promise may be be cancelled with `cancel()` and will be cancelled
 * if a parent scope is cancelled, e.g. when the entire workflow is cancelled.
 *
 * @see {@link https://docs.temporal.io/docs/node/workflow-scopes-and-cancellation | Workflow scopes and cancellation}
 */
export function cancellationScope<T>(fn: () => Promise<T>): Promise<T> {
  return childScope(propagateCancellation('requestCancel'), propagateCancellation('completeCancel'), fn);
}

const ignoreCancellation = () => () => undefined;

/**
 * Wraps the Promise returned from `fn` with a shielded scope.
 * Any child scopes of this scope will *not* be cancelled if `shield` is cancelled.
 * By default `shield` throws the original {@link CancellationError} in order for any awaiter
 * to immediately be notified of the cancellation.
 * @param throwOnCancellation - Pass false in case the result of the shielded `Promise` is needed
 * despite cancellation. To see if the workflow was cancelled while waiting, check `Context.cancelled`.
 * @see {@link https://docs.temporal.io/docs/node/workflow-scopes-and-cancellation | Workflow scopes and cancellation}
 */
export function shield<T>(fn: () => Promise<T>, throwOnCancellation = true): Promise<T> {
  const cancellationFunction: CancellationFunctionFactory = throwOnCancellation
    ? (cancel) => cancel
    : ignoreCancellation;
  return childScope(cancellationFunction, cancellationFunction, fn);
}

/**
 * Cancel a scope created by an activity, timer or cancellationScope.
 *
 * @see {@link https://docs.temporal.io/docs/node/workflow-scopes-and-cancellation | Workflow scopes and cancellation}
 */
export function cancel(promise: Promise<any>, reason = 'Cancelled'): void {
  if (state.runtime === undefined) {
    // This shouldn't happen
    throw new Error('Uninitialized workflow');
  }
  const data = state.runtime.getPromiseData(promise);
  if (data === undefined) {
    throw new Error('Expected to find promise scope, got undefined');
  }
  if (!data.cancellable) {
    throw new Error('Promise is not cancellable');
  }

  try {
    data.scope.requestCancel(new CancellationError(reason, 'internal'));
  } catch (e) {
    if (!(e instanceof CancellationError)) throw e;
  }
}

/**
 * Generate an RFC compliant V4 uuid.
 * Uses the workflow's deterministic PRNG making it safe for use within a workflow.
 * This function is cryptograpically insecure.
 * See the {@link https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid | stackoverflow discussion}.
 */
export function uuid4(): string {
  // Return the hexadecimal text representation of number `n`, padded with zeroes to be of length `p`
  const ho = (n: number, p: number) => n.toString(16).padStart(p, '0');
  // Create a view backed by a 16-byte buffer
  const view = new DataView(new ArrayBuffer(16));
  // Fill buffer with random values
  view.setUint32(0, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(4, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(8, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(12, (Math.random() * 0x100000000) >>> 0);
  // Patch the 6th byte to reflect a version 4 UUID
  view.setUint8(6, (view.getUint8(6) & 0xf) | 0x40);
  // Patch the 8th byte to reflect a variant 1 UUID (version 4 UUIDs are)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  // Compile the canonical textual form from the array data
  return `${ho(view.getUint32(0), 8)}-${ho(view.getUint16(4), 4)}-${ho(view.getUint16(6), 4)}-${ho(
    view.getUint16(8),
    4
  )}-${ho(view.getUint32(10), 8)}${ho(view.getUint16(14), 4)}`;
}
