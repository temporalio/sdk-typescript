import type { AsyncLocalStorage as ALS } from 'node:async_hooks';

// AsyncLocalStorage is injected via vm module into global scope.
// In case Workflow code is imported in Node.js context, replace with an empty class.
export const AsyncLocalStorage: new <T>() => ALS<T> = (globalThis as any).AsyncLocalStorage ?? class {};
