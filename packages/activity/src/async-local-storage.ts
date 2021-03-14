/// Fallback implementation of AsyncLocalStorage for older node versions
import { createHook, executionAsyncId } from 'async_hooks';

class AsyncLocalStorage<T> {
  asyncIdToResource: Map<number, T> = new Map();
  resourceToAsyncIds: Map<T, Set<number>> = new Map();
  unregisterQueue: Set<string> = new Set();

  protected _register(resource: T, asyncId: number = executionAsyncId()): void {
    this.asyncIdToResource.set(asyncId, resource);
    let asyncIds = this.resourceToAsyncIds.get(resource);
    if (asyncIds === undefined) {
      asyncIds = new Set();
      this.resourceToAsyncIds.set(resource, asyncIds);
    }
    asyncIds.add(asyncId);
  }

  protected _unregister(resource: T): void {
    const asyncIds = this.resourceToAsyncIds.get(resource);
    if (asyncIds === undefined) {
      return;
    }
    for (const asyncId of asyncIds) {
      this.asyncIdToResource.delete(asyncId);
    }
    this.resourceToAsyncIds.delete(resource);
  }

  public _link(id: number, trigger: number): void {
    const resource = this.asyncIdToResource.get(trigger);
    if (resource) {
      this._register(resource, id);
    }
  }

  public getStore(): T | undefined {
    return this.asyncIdToResource.get(executionAsyncId());
  }

  public async run<A extends any[], R>(store: T, callback: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    if (this.resourceToAsyncIds.size === 0) {
      const firstRun = storageSet.size === 0;
      // First resource
      storageSet.add(this);

      if (firstRun) {
        hook.enable();
      }
    }
    this._register(store);
    try {
      return await callback(...args);
    } finally {
      this._unregister(store);
      if (this.resourceToAsyncIds.size === 0) {
        storageSet.delete(this);
        if (storageSet.size === 0) {
          hook.disable();
        }
      }
    }
  }
}

const storageSet: Set<AsyncLocalStorage<any>> = new Set();

const hook = createHook({
  init: (id: number, _type: string, triggerId: number) => {
    for (const s of storageSet) {
      s._link(id, triggerId);
    }
  },
});

export { AsyncLocalStorage };
