import { temporal } from '../../proto/core-interface';
import { ActivityOptions, ActivityFunction } from './interfaces';
import { state, currentScope, childScope, propagateCancellation } from './internals';
import { CancellationError } from './errors';
import { msToTs } from './time';

export { CancellationError, ActivityOptions };

// Delete any weak reference holding structures because GC is non-deterministic.
// WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0, delete it just in case.
delete (globalThis as any).WeakMap;
delete (globalThis as any).WeakSet;
delete (globalThis as any).WeakRef;

declare global {
  // es2015.collection - WeakMap and WeakSet omitted
  interface Map<K, V> {
    clear(): void;
    delete(key: K): boolean;
    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void;
    get(key: K): V | undefined;
    has(key: K): boolean;
    set(key: K, value: V): this;
    readonly size: number;
  }

  interface MapConstructor {
    new(): Map<any, any>;
    new<K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
    readonly prototype: Map<any, any>;
  }
  export var Map: MapConstructor;

  interface ReadonlyMap<K, V> {
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: any): void;
    get(key: K): V | undefined;
    has(key: K): boolean;
    readonly size: number;
  }

  interface Set<T> {
    add(value: T): this;
    clear(): void;
    delete(value: T): boolean;
    forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any): void;
    has(value: T): boolean;
    readonly size: number;
  }

  interface SetConstructor {
    new <T = any>(values?: readonly T[] | null): Set<T>;
    readonly prototype: Set<any>;
  }
  export var Set: SetConstructor;

  interface ReadonlySet<T> {
    forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: any): void;
    has(value: T): boolean;
    readonly size: number;
  }
  // END(es2015.collection)

  export interface Console {
    log(...args: any[]): void;
  }

  export var console: Console;
  export function setTimeout(cb: (...args: any[]) => any, ms: number, ...args: any[]): number;
  export function clearTimeout(handle: number): void;
}

const OriginalDate = (globalThis as any).Date;

(globalThis as any).Date = function() {
  // TODO: implement for after local activity completion
  return new OriginalDate(state.now);
};

(globalThis as any).Date.now = function() {
  // TODO: implement for after local activity completion
  return state.now;
};

(globalThis as any).Date.prototype = OriginalDate.prototype;


(globalThis as any).setTimeout = function(cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
  const seq = state.nextSeq++;
  state.completions.set(seq, {
    resolve: () => cb(...args),
    reject: () => {}, /* ignore cancellation */
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
  return seq;
};

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
    () => new Promise((resolve, reject) => {
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

(globalThis as any).clearTimeout = function(handle: number): void {
  state.nextSeq++;
  state.completions.delete(handle);
  state.commands.push({
    api: {
      commandType: temporal.api.enums.v1.CommandType.COMMAND_TYPE_CANCEL_TIMER,
      cancelTimerCommandAttributes: {
        timerId: `${handle}`,
      },
    },
  });
};

export interface InternalActivityFunction<P extends any[], R> extends ActivityFunction<P, R> {
  module: string;
  options: ActivityOptions;
}

export function scheduleActivity<R>(_module: string, _name: string, _args: any[], _options: ActivityOptions) {
  const seq = state.nextSeq++;
  // state.commands.push({ type: 'ScheduleActivity', seq, module, name, arguments: args, options });
  state.commands.push({
    api: {
      commandType: temporal.api.enums.v1.CommandType.COMMAND_TYPE_SCHEDULE_ACTIVITY_TASK,
      scheduleActivityTaskCommandAttributes: {},
    },
  });
  return new Promise<R>((resolve, reject) => {
    state.completions.set(seq, { resolve, reject, scope: currentScope() });
  });
}

class ContextImpl {
  public configure<P extends any[], R>(activity: ActivityFunction<P, R>, options: ActivityOptions): ActivityFunction<P, R> {
    const internalActivity = activity as InternalActivityFunction<P, R>;
    const mergedOptions = { ...internalActivity.options, ...options };
    // Wrap the function in an object so it gets the original function name
    const { [internalActivity.name]: fn } = {
      [internalActivity.name](...args: P) {
        return scheduleActivity<R>(internalActivity.module, internalActivity.name, args, mergedOptions);
      }
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
  public cancel(reason: string = 'Cancelled'): void {
    try {
      state.scopeStack[0]!.cancel(new CancellationError(reason));
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
export function shield<T>(fn: () => Promise<T>, throwOnCancellation: boolean = true): Promise<T> {
  if (throwOnCancellation) {
    return childScope((cancel) => cancel, fn);
  } else {
    // Ignore cancellation
    return childScope(() => () => {}, fn);
  }
}

/**
 * Cancel a scope created by an activity, timer or cancellationScope.
 */
export function cancel(promise: Promise<any>, reason: string = 'Cancelled'): void {
  const data = state.runtime!.getPromiseData(promise);
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
