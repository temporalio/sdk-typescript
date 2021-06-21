import { CancellationScope, ROOT_SCOPE, pushScope, popScope } from './cancellation-scope';

/** v8 hook types */
export type HookType = 'init' | 'resolve' | 'before' | 'after';
/** Type of the PromiseHook callback */
export type PromiseHook = (t: HookType, p: Promise<any>, pp?: Promise<any>) => void;

/**
 * Interface for the native (c++) isolate extension, exposes method for working with the v8 Promise hook and custom Promise data
 */
export interface IsolateExtension {
  registerPromiseHook(hook: PromiseHook): void;
  /** Associate a Promise with its CancellationScope */
  setPromiseData(p: Promise<any>, s: CancellationScope): void;
  /** Get the CancellationScope associated with a Promise */
  getPromiseData(p: Promise<any>): CancellationScope | undefined;
}

/**
 * Uses the v8 PromiseHook callback to track the current `CancellationScope`
 */
export class ScopeHookManager {
  protected readonly childScopes = new Map<CancellationScope, Set<CancellationScope>>();

  constructor(protected readonly isolateExtension: IsolateExtension) {
    isolateExtension.registerPromiseHook(this.hook.bind(this));
  }

  /**
   * The PromiseHook implementation
   *
   * Note that the parent promise is unused as it was not found neccessary for the implementation
   */
  hook(t: HookType, p: Promise<any>, _pp?: Promise<any>): void {
    switch (t) {
      // When a Promise is created associate it with a CancellationScope
      case 'init':
        this.isolateExtension.setPromiseData(p, CancellationScope.current());
        break;
      // Called at the beginning of the PromiseReactionJob,
      // p is the promise about to execute, resume its scope.
      case 'before':
        pushScope(this.isolateExtension.getPromiseData(p) || ROOT_SCOPE);
        break;
      // Called at the end of the PromiseReactionJob,
      // pop the current Promise off the scope stack.
      case 'after':
        popScope();
        break;
    }
  }
}
