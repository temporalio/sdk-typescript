import { temporal } from '@temporalio/proto';
import { ActivityOptions, ActivityFunction } from './interfaces';
import { state, currentScope, childScope, propagateCancellation } from './internals';
import { defaultDataConverter } from './converter/data-converter';
import { CancellationError } from './errors';
import { msToTs, msOptionalStrToTs } from './time';

export function sleep(ms: number): Promise<void> {
  const seq = state.nextSeq++;
  return childScope(
    (reject) => (err) => {
      if (!state.completions.delete(seq)) {
        return; // Already resolved
      }
      state.commands.push({
        api: {
          commandType: temporal.api.enums.v1.CommandType.COMMAND_TYPE_CANCEL_TIMER,
          cancelTimerCommandAttributes: {
            timerId: `${seq}`,
          },
        },
      });
      reject(err);
    },
    () =>
      new Promise((resolve, reject) => {
        state.completions.set(seq, {
          resolve,
          reject,
          scope: currentScope(),
        });
        state.commands.push({
          api: {
            commandType: temporal.api.enums.v1.CommandType.COMMAND_TYPE_START_TIMER,
            startTimerCommandAttributes: {
              timerId: `${seq}`,
              startToFireTimeout: msToTs(ms),
            },
          },
        });
      })
  );
}

export interface InternalActivityFunction<P extends any[], R> extends ActivityFunction<P, R> {
  module: string;
  options: ActivityOptions;
}

export function scheduleActivity<R>(module: string, name: string, args: any[], options: ActivityOptions): Promise<R> {
  const seq = state.nextSeq++;
  return childScope(
    (reject) => (err) => {
      if (!state.completions.delete(seq)) {
        return; // Already resolved
      }
      state.commands.push({
        core: {
          requestActivityCancellation: {
            activityId: `${seq}`,
          },
        },
      });
      reject(err);
    },
    () =>
      new Promise((resolve, reject) => {
        state.completions.set(seq, {
          resolve,
          reject,
          scope: currentScope(),
        });
        state.commands.push({
          api: {
            commandType: temporal.api.enums.v1.CommandType.COMMAND_TYPE_SCHEDULE_ACTIVITY_TASK,
            scheduleActivityTaskCommandAttributes: {
              activityId: `${seq}`,
              activityType: {
                name: JSON.stringify([module, name]),
              },
              input: defaultDataConverter.toPayloads(...args),
              retryPolicy: options.retry
                ? {
                    maximumAttempts: options.retry.maximumAttempts,
                    initialInterval: msOptionalStrToTs(options.retry.initialInterval),
                    maximumInterval: msOptionalStrToTs(options.retry.maximumInterval),
                    backoffCoefficient: options.retry.backoffCoefficient,
                    // TODO: nonRetryableErrorTypes
                  }
                : undefined,
              taskQueue: options.type === 'remote' ? { name: options.taskQueue } : undefined,
              heartbeatTimeout: msOptionalStrToTs(options.heartbeatTimeout),
              startToCloseTimeout: msOptionalStrToTs(options.startToCloseTimeout),
              scheduleToCloseTimeout: msOptionalStrToTs(options.scheduleToCloseTimeout),
              scheduleToStartTimeout: msOptionalStrToTs(options.scheduleToStartTimeout),
              // TODO: namespace, header
            },
          },
        });
      })
  );
}

class ContextImpl {
  public configure<P extends any[], R>(
    activity: ActivityFunction<P, R>,
    options: ActivityOptions
  ): ActivityFunction<P, R> {
    const internalActivity = activity as InternalActivityFunction<P, R>;
    const mergedOptions = { ...internalActivity.options, ...options };
    // Wrap the function in an object so it gets the original function name
    const { [internalActivity.name]: fn } = {
      [internalActivity.name](...args: P) {
        return scheduleActivity<R>(internalActivity.module, internalActivity.name, args, mergedOptions);
      },
    };
    const configured = fn as InternalActivityFunction<P, R>;
    configured.module = internalActivity.module;
    configured.options = mergedOptions;
    return configured;
  }
  public get cancelled(): boolean {
    return state.cancelled;
  }

  /**
   * Cancel the current workflow
   */
  public cancel(reason = 'Cancelled'): void {
    try {
      state.rootScope.cancel(new CancellationError(reason));
    } catch (e) {
      if (!(e instanceof CancellationError)) throw e;
    }
  }
}

export const Context = new ContextImpl();

/**
 * Wraps Promise returned from `fn` with a cancellation scope.
 * The returned Promise may be be cancelled with `cancel()` and will be cancelled
 * if a parent scope is cancelled, e.g. when the entire workflow is cancelled.
 */
export function cancellationScope<T>(fn: () => Promise<T>): Promise<T> {
  return childScope(propagateCancellation, fn);
}

/**
 * Wraps the Promise returned from `fn` with a shielded scope.
 * Any child scopes of this scope will *not* be cancelled if `shield` is cancelled.
 * By default `shield` throws the original `CancellationError` in order for any awaiter
 * to immediately be notified of the cancellation.
 * @param throwOnCancellation - Pass false in case the result of the shielded `Promise` is needed
 * despite cancellation. To see if the workflow was cancelled while waiting, check `Context.cancelled`.
 */
export function shield<T>(fn: () => Promise<T>, throwOnCancellation = true): Promise<T> {
  if (throwOnCancellation) {
    return childScope((cancel) => cancel, fn);
  } else {
    // Ignore cancellation
    return childScope(() => () => undefined, fn);
  }
}

/**
 * Cancel a scope created by an activity, timer or cancellationScope.
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
    data.scope.cancel(new CancellationError(reason));
  } catch (e) {
    if (!(e instanceof CancellationError)) throw e;
  }
}
