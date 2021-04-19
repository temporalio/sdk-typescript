export interface AsyncLocalStorage<T> {
  getStore(): T | undefined;
  run<A extends any[], R>(store: T, callback: (...args: A) => Promise<R>, ...args: A): Promise<R>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
let { AsyncLocalStorage } = require('async_hooks');

if (AsyncLocalStorage === undefined) {
  AsyncLocalStorage = require('./async-local-storage');
}

/**
 * Workaround for the conditional require making AsyncLocalStorage 'any'
 */
function getAsyncLocalStorage(): AsyncLocalStorage<any> {
  return new AsyncLocalStorage();
}

export const asyncLocalStorage = getAsyncLocalStorage();
