import { ContextType, ActivityOptions, ActivityFunction } from './types';
import { state } from './internals';

export { ContextType, ActivityOptions };

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

(globalThis as any).setTimeout = function(cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
  const seq = state.nextSeq++;
  state.callbacks.set(seq, [() => cb(...args), () => {} /* ignore cancellation */]);
  state.commands.push({ type: 'ScheduleTimer', seq, ms });
  return seq;
};

(globalThis as any).clearTimeout = function(handle: number): void {
  const seq = state.nextSeq++;
  state.callbacks.delete(handle);
  state.commands.push({ type: 'CancelTimer', seq, timerSeq: handle });
};

export interface InternalActivityFunction<P extends any[], R> extends ActivityFunction<P, R> {
  module: string;
  options: ActivityOptions;
}

export function scheduleActivity<R>(module: string, name: string, args: any[], options: ActivityOptions) {
  const seq = state.nextSeq++;
  state.commands.push({ type: 'ScheduleActivity', seq, module, name, arguments: args, options });
  return new Promise<R>((resolve, reject) => {
    state.callbacks.set(seq, [resolve, reject]);
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
}
