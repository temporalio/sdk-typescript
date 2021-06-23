import { IllegalStateError } from './errors';

/** v8 hook types */
export type HookType = 'init' | 'resolve' | 'before' | 'after';
/** Type of the PromiseHook callback */
export type PromiseHook = (t: HookType, p: Promise<any>, pp?: Promise<any>) => void;

/**
 * Interface for the native (c++) isolate extension, exposes method for working with the v8 Promise hook and custom Promise data
 */
export interface IsolateExtension {
  registerPromiseHook(hook: PromiseHook): void;
  /** Associate a Promise with each hook's custom data */
  setPromiseData(p: Promise<any>, s: Map<PromiseHook, any>): void;
  /** Get the custom hook data associated with a Promise */
  getPromiseData(p: Promise<any>): Map<PromiseHook, any> | undefined;
}

/**
 * Uses the v8 PromiseHook callback to track the current `CancellationScope`
 */
export class HookManager {
  protected readonly registeredHooks = new Set<PromiseHook>();
  /**
   * A reference to the native isolate extension, lazily initialized along with the Workflow
   */
  protected isolateExtension?: IsolateExtension;

  protected constructor() {
    // Prevent construction other than the singleton
  }

  // Singleton instance
  public static instance = new HookManager();

  /**
   * To be called from the Workflow runtime library to set the native module reference
   */
  setIsolateExtension(isolateExtension: IsolateExtension): void {
    this.isolateExtension = isolateExtension;
    isolateExtension.registerPromiseHook(this.hook.bind(this));
  }

  /**
   * Helper that ensures isolateExtension has been set
   */
  getIsolateExtension(): IsolateExtension {
    if (this.isolateExtension === undefined) {
      throw new IllegalStateError('HookManager has not been properly initialized');
    }
    return this.isolateExtension;
  }

  /**
   * Register a single promise hook callback
   */
  register(hook: PromiseHook): void {
    this.registeredHooks.add(hook);
  }

  /**
   * Deregister a single promise hook callback
   */
  deregister(hook: PromiseHook): void {
    this.registeredHooks.delete(hook);
  }

  /**
   * The PromiseHook implementation, calls all registered hooks
   */
  protected hook(t: HookType, p: Promise<any>, pp?: Promise<any>): void {
    for (const hook of this.registeredHooks) {
      hook(t, p, pp);
    }
  }

  /**
   * Get custom promise data for a promise hook
   */
  public getPromiseData(p: Promise<any>, hook: PromiseHook): unknown {
    const data = this.getIsolateExtension().getPromiseData(p);
    if (data) {
      return data.get(hook);
    }
  }

  /**
   * Set custom promise data for a promise hook
   */
  public setPromiseData(p: Promise<any>, hook: PromiseHook, data: unknown): void {
    const isolateExtension = this.getIsolateExtension();
    let mapping = isolateExtension.getPromiseData(p);
    if (!mapping) {
      mapping = new Map();
      isolateExtension.setPromiseData(p, mapping);
    }
    mapping.set(hook, data);
  }
}
