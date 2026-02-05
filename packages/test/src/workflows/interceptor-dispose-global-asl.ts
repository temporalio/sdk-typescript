import type { AsyncLocalStorage as ALS } from 'node:async_hooks';
import { WorkflowInterceptors } from '@temporalio/workflow';

// AsyncLocalStorage is injected via vm module into global scope.
// In case Workflow code is imported in Node.js context, replace with an empty class.
export const AsyncLocalStorage: new <T>() => ALS<T> = (globalThis as any).AsyncLocalStorage ?? class {};

const wfWorkerThreadContext = globalThis.constructor.constructor;

export async function initAsyncLocalStorage(): Promise<boolean> {
  const workerContextGlobalThis = wfWorkerThreadContext('return globalThis')();
  // Create an ASL in the current async context, assign it in scope of the worker context.
  workerContextGlobalThis.__test_asl__ = new AsyncLocalStorage();
  // Run enterWith in worker context to set asl store.
  // We use enterWith to keep the ASL context throughout *sync* execution
  // (this makes the store accessible between async calls - which we need
  //  to check the store in subsequent wf runs - 'run' does not)
  wfWorkerThreadContext(`globalThis.__test_asl__.enterWith('test')`)();
  return checkAsyncLocalStorageDefined();
}

export async function checkAsyncLocalStorageDefined(): Promise<boolean> {
  const res = wfWorkerThreadContext(`return globalThis.__test_asl__?.getStore() !== undefined`)();
  const store = wfWorkerThreadContext(`return globalThis.__test_asl__`)();
  console.log('WF THREAD CONTEXT ASL', store);
  console.log('WF THREAD CONTEXT GET STORE RES', res);
  return res;
}

export const interceptors = (): WorkflowInterceptors => ({
  internals: [
    {
      dispose(input, next) {
        wfWorkerThreadContext(`globalThis.__test_asl__?.disable()`)();
        return next(input);
      },
    },
  ],
});
