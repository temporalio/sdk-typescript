import { Activity as _Activity, Fn } from './activity';
export {}

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
  export interface Activity<F extends Fn<any[], Promise<any>>> extends _Activity<F> {}

}
