import { temporal } from '../../proto/core-interface';
import { ContextType, ActivityOptions, ActivityFunction } from './interfaces';
import { state, currentScope, childScope, propagateCancellation } from './internals';
import { CancellationError } from './errors';
import { msToTs } from './time';

export { CancellationError, ContextType, ActivityOptions };

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

export const Context: ContextType = {
  configure<P extends any[], R>(activity: ActivityFunction<P, R>, options: ActivityOptions): ActivityFunction<P, R> {
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
  },
  shield<T>(fn: () => Promise<T>): Promise<T> {
    return childScope((cancel) => cancel, fn);
  },
  scope<T>(fn: () => Promise<T>): Promise<T> {
    return childScope(propagateCancellation, fn);
  },
  cancel(promiseOrReason?: Promise<any> | string, reason?: string): void {
    try {
      const promise = promiseOrReason instanceof Promise ? promiseOrReason : undefined;
      const reasonStr = typeof promiseOrReason === 'string' ? promiseOrReason : (reason || 'Cancelled');
      const data = promise !== undefined ? state.runtime!.getPromiseData(promise) : undefined;
      if (data === undefined) {
        throw new Error('Expected to find promise scope, got undefined');
      }
      if (!data.cancellable) {
        throw new Error('Promise is not cancellable');
      }
      data.scope.cancel(new CancellationError(reasonStr));
    } catch (e) {
      if (!(e instanceof CancellationError)) throw e;
    }

  }
}
