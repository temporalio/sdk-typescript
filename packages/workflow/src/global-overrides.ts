/* eslint no-var: 0 */
import { temporal } from '@temporalio/proto';
import { state, currentScope } from './internals';
import { msToTs } from './time';

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
    new (): Map<any, any>;
    new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
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

(globalThis as any).Date = function () {
  // TODO: implement for after local activity completion
  return new OriginalDate(state.now);
};

(globalThis as any).Date.now = function () {
  // TODO: implement for after local activity completion
  return state.now;
};

(globalThis as any).Date.prototype = OriginalDate.prototype;

(globalThis as any).setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
  const seq = state.nextSeq++;
  state.completions.set(seq, {
    resolve: () => cb(...args),
    reject: () => undefined /* ignore cancellation */,
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

(globalThis as any).clearTimeout = function (handle: number): void {
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
