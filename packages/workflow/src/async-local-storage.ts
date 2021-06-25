import { HookManager, HookType } from './promise-hooks';

/**
 * Workflow isolate (mostly compatible) port of Node's {@link https://nodejs.org/docs/latest/api/async_hooks.html#async_hooks_class_asynclocalstorage | AsyncLocalStorage}.
 *
 * **IMPORTANT** Works for Promises (and async functions) only, not for callbacks.
 *
 * @example
 * ```ts
 * const storage = new AsyncLocalStorage<number>();
 *
 * storage.run(1, async () => {
 *   storage.getStore(); // 1
 *   await sleep(20);
 *   storage.getStore(); // 1
 *   setTimeout(() => {
 *     storage.getStore(); // undefined
 *   }, 20);
 * });
 * ```
 */
export class AsyncLocalStorage<T> {
  /** Used by AsyncLocalStorage.run and PromiseHooks to track the current store */
  protected readonly stack = new Array<T>();

  constructor() {
    HookManager.instance.register(this.hook);
  }

  /**
   * Disables the instance of AsyncLocalStorage. Subsequent calls to `asyncLocalStorage.getStore()` **might** return undefined.
   *
   * Calling `asyncLocalStorage.disable()` is required before the asyncLocalStorage can be garbage collected.
   * This does not apply to stores provided by the asyncLocalStorage, as those objects are garbage collected
   * along with the corresponding async resources.
   *
   * Use this method when the asyncLocalStorage is not in use anymore in the current process.
   */
  public disable(): void {
    HookManager.instance.deregister(this.hook);
  }

  /**
   * Returns the current store.
   *
   * If called outside of an asynchronous context initialized by calling `asyncLocalStorage.run()` it returns undefined.
   */
  getStore(): T | undefined {
    if (this.stack.length === 0) {
      return undefined;
    }
    return this.stack[this.stack.length - 1];
  }

  /**
   * Runs a function synchronously within a context and returns its return value.
   * The store is not accessible outside of the callback function. The store is accessible to any
   * asynchronous operations created within the callback.
   *
   * The optional args are passed to the callback function.
   */
  public run<A extends any[], R>(store: T, callback: (...args: A) => R, ...args: A): R {
    this.stack.push(store);
    try {
      return callback(...args);
    } finally {
      this.stack.pop();
    }
  }

  /**
   * Hook into the v8 PromiseHook callback to keep track of the current store.
   *
   * This function is bound to the class instance so it can be used as a unique key for
   * registration and promise data mapping.
   */
  protected hook = (t: HookType, p: Promise<any>): void => {
    switch (t) {
      // When a Promise is created associate it with a the current store.
      case 'init':
        HookManager.instance.setPromiseData(p, this.hook, this.getStore());
        break;
      // Called at the beginning of the PromiseReactionJob,
      // p is the promise about to execute, resume its store.
      case 'before':
        this.stack.push(HookManager.instance.getPromiseData(p, this.hook) as T);
        break;
      // Called at the end of the PromiseReactionJob,
      // pop the current Promise off the store stack.
      case 'after':
        this.stack.pop();
        break;
    }
  };
}
