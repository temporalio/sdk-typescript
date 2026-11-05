import { AsyncLocalStorage as NativeAsyncLocalStorage } from 'node:async_hooks';
import { maybeGetActivator } from './vmless-context';

export class AsyncLocalStorage<T> extends NativeAsyncLocalStorage<T> {
  constructor() {
    super();
    // Instances constructed during SDK bootstrap are shared. Only execution-owned
    // storage (for example scoped randomness) is disabled when a run is disposed.
    maybeGetActivator()?.workflowSandboxDestructors.push(() => this.disable());
  }
}
