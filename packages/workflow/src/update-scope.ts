import type { AsyncLocalStorage as ALS } from 'node:async_hooks';
import { AsyncLocalStorage } from './async-local-storage';

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

export { AsyncLocalStorage };

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

const storage: ALS<UpdateScope> = new AsyncLocalStorage();
