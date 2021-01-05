// All timeouts and intervals accept ms format strings (see: https://www.npmjs.com/package/ms).

// See: https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/activity/ActivityOptions.Builder.html
interface CommonActivityOptions {
  scheduleToCloseTimeout?: string,
  startToCloseTimeout?: string,
  scheduleToStartTimeout?: string,
  heartbeatTimeout?: string,
  /**
   * If not defined, will not retry, otherwise retry with given options
   */
  retry?: RetryOptions,
}

interface LocalActivityOptions extends CommonActivityOptions {
  type: 'local',
}

// 
interface RemoteActivityOptions extends CommonActivityOptions {
  type: 'remote',
  taskQueue: string,
}

// See: https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/common/RetryOptions.Builder.html
interface RetryOptions {
  backoffCoefficient?: number,
  initialInterval?: string,
  maximumAttempts?: number,
  maximumInterval?: string,
}

type ActivityOptions = RemoteActivityOptions | LocalActivityOptions;

export type ActivityFunction<P extends any[], R> = (...args: P) => Promise<R>;

export interface ContextType {
  configure<P extends any[], R>(activity: ActivityFunction<P, R>, options: ActivityOptions): ActivityFunction<P, R>;
}

export declare var Context: ContextType;

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
