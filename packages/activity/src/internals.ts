import { AsyncLocalStorage, Context } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
let { AsyncLocalStorage } = require('async_hooks');

if (AsyncLocalStorage === undefined) {
  AsyncLocalStorage = require('./async-local-storage');
}

/**
 * Workaround for the conditional require making AsyncLocalStorage 'any'
 */
function getAsyncLocalStorage(): AsyncLocalStorage<Context> {
  return new AsyncLocalStorage();
}

export const asyncLocalStorage = getAsyncLocalStorage();
