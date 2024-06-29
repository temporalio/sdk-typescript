import type { AsyncLocalStorage as ALS } from 'node:async_hooks';

/**
 * Option for constructing a UpdateScope
 */
export interface UpdateScopeOptions {
  /**
   *  A workflow-unique identifier for this update.
   */
  id: string;

  /**
   *  The update type name.
   */
  name: string;
}

// AsyncLocalStorage is injected via vm module into global scope.
// In case Workflow code is imported in Node.js context, replace with an empty class.
export const AsyncLocalStorage: new <T>() => ALS<T> = (globalThis as any).AsyncLocalStorage ?? class {};

export class UpdateScope {
  /**
   *  A workflow-unique identifier for this update.
   */
  public readonly id: string;

  /**
   *  The update type name.
   */
  public readonly name: string;

  constructor(options: UpdateScopeOptions) {
    this.id = options.id;
    this.name = options.name;
  }

  /**
   * Activate the scope as current and run the update handler `fn`.
   *
   * @return the result of `fn`
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return storage.run(this, fn);
  }

  /**
   * Get the current "active" update scope.
   */
  static current(): UpdateScope | undefined {
    return storage.getStore();
  }

  /** Alias to `new UpdateScope({ id, name }).run(fn)` */
  static updateWithInfo<T>(id: string, name: string, fn: () => Promise<T>): Promise<T> {
    return new this({ id, name }).run(fn);
  }
}

const storage = new AsyncLocalStorage<UpdateScope>();

/**
 * Disable the async local storage for updates.
 */
export function disableUpdateStorage(): void {
  storage.disable();
}
