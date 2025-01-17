import vm from 'node:vm';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { IllegalStateError } from '@temporalio/common';
import { deepFreeze } from '@temporalio/common/lib/type-helpers';
import { getTimeOfDay } from '@temporalio/core-bridge';
import { timeOfDayToBigint } from '../logger';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';
import {
  BaseVMWorkflow,
  globalHandlers,
  injectConsole,
  injectGlobals,
  setUnhandledRejectionHandler,
} from './vm-shared';

interface BagHolder {
  bag: any;
}

const callFn = new vm.Script(`
                // runInContext does not accept args, so pass them via the __TEMPORAL_ARGS__ global variable
                {
                  const [holder, fn, args] = globalThis.__TEMPORAL_ARGS__;
                  delete globalThis.__TEMPORAL_ARGS__;

                  if (globalThis.__TEMPORAL_BAG_HOLDER__ !== holder) {
                    if (globalThis.__TEMPORAL_BAG_HOLDER__ !== undefined) {
                      globalThis.__TEMPORAL_BAG_HOLDER__.bag = Object.getOwnPropertyDescriptors(globalThis);
                    }

                    // Restore global properties for this context
                    Object.defineProperties(globalThis, holder.bag);

                    // Delete extra properties, left from the former context
                    for (const prop of Reflect.ownKeys(globalThis)) {
                      if (!(prop in holder.bag)) {
                        delete globalThis[prop];
                      }
                    }

                    globalThis.__TEMPORAL_BAG_HOLDER__ = holder;
                  }

                  __TEMPORAL__.api[fn](...args)
                }
              `);

/**
 * A WorkflowCreator that creates VMWorkflows in the current isolate
 */
export class ReusableVMWorkflowCreator implements WorkflowCreator {
  /**
   * TODO(bergundy): Get rid of this static state somehow
   */
  private static unhandledRejectionHandlerHasBeenSet = false;
  static workflowByRunId = new Map<string, ReusableVMWorkflow>();

  /**
   * Optional context - this attribute is deleted upon on {@link destroy}
   *
   * Use the {@link context} getter instead
   */
  private _context?: vm.Context;
  private pristineObj?: object;

  constructor(
    script: vm.Script,
    protected readonly workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    protected readonly isolateExecutionTimeoutMs: number,
    /** Known activity names registered on the executing worker */
    protected readonly registeredActivityNames: Set<string>
  ) {
    if (!ReusableVMWorkflowCreator.unhandledRejectionHandlerHasBeenSet) {
      setUnhandledRejectionHandler((runId) => ReusableVMWorkflowCreator.workflowByRunId.get(runId));
      ReusableVMWorkflowCreator.unhandledRejectionHandlerHasBeenSet = true;
    }

    this._context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });

    this.injectConsole();
    injectGlobals(this.context);

    const sharedModules = new Map<string | symbol, any>();
    const __webpack_module_cache__ = new Proxy(
      {},
      {
        get: (_, p) => {
          // Try the shared modules first
          const sharedModule = sharedModules.get(p);
          if (sharedModule) {
            return sharedModule;
          }
          const moduleCache = this.context.__TEMPORAL_ACTIVATOR__?.moduleCache;
          return moduleCache?.get(p);
        },
        set: (_, p, val) => {
          const moduleCache = this.context.__TEMPORAL_ACTIVATOR__?.moduleCache;
          if (moduleCache != null) {
            moduleCache.set(p, val);
          } else {
            // Workflow has not yet been loaded, share the module
            sharedModules.set(p, val);
          }
          return true;
        },
      }
    );
    Object.defineProperty(this._context, '__webpack_module_cache__', {
      value: __webpack_module_cache__,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    script.runInContext(this.context);

    // The V8 context is really composed of two distinct objects: the 'this._context' object on the outside, and another
    // internal object to which we only have access from the inside, which defines the built-in global properties.
    // Node makes some attempt at keeping the two in sync, but it's not perfect. To avoid various inconsistencies,
    // we capture the global variables from the inside of the V8 context.
    this.pristineObj = vm.runInContext(`Object.getOwnPropertyDescriptors(globalThis)`, this.context);

    for (const k of [
      ...Object.getOwnPropertyNames(this.pristineObj),
      ...Object.getOwnPropertySymbols(this.pristineObj),
    ]) {
      if (k !== 'globalThis') {
        const v: PropertyDescriptor = (this.pristineObj as any)[k];
        v.value = deepFreeze(v.value);
      }
    }

    for (const v of sharedModules.values()) deepFreeze(v);
  }

  protected get context(): vm.Context {
    const { _context } = this;
    if (_context == null) {
      throw new IllegalStateError('Tried to use v8 context after Workflow creator was destroyed');
    }
    return _context;
  }

  /**
   * Inject console.log and friends into a vm context.
   *
   * Overridable for test purposes.
   */
  protected injectConsole(): void {
    injectConsole(this.context);
  }

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const context = this.context;
    const holder: BagHolder = { bag: this.pristineObj! };

    const { isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            // By the time we get out of this call, all microtasks will have been executed
            context.__TEMPORAL_ARGS__ = [holder, fn, args];
            return callFn.runInContext(context, {
              timeout: isolateExecutionTimeoutMs,
              displayErrors: true,
            });
          };
        },
      }
    ) as any;

    workflowModule.initRuntime({
      ...options,
      sourceMap: this.workflowBundle.sourceMap,
      getTimeOfDay: () => timeOfDayToBigint(getTimeOfDay()),
      registeredActivityNames: this.registeredActivityNames,
    });
    const activator = context['__TEMPORAL_ACTIVATOR__'];
    const newVM = new ReusableVMWorkflow(options.info.runId, context, activator, workflowModule);
    ReusableVMWorkflowCreator.workflowByRunId.set(options.info.runId, newVM);
    return newVM;
  }

  /**
   * Create a new instance, pre-compile scripts from given code.
   *
   * This method is generic to support subclassing.
   */
  public static async create<T extends typeof ReusableVMWorkflowCreator>(
    this: T,
    workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    isolateExecutionTimeoutMs: number,
    registeredActivityNames: Set<string>
  ): Promise<InstanceType<T>> {
    globalHandlers.install(); // Call is idempotent
    await globalHandlers.addWorkflowBundle(workflowBundle);
    const script = new vm.Script(workflowBundle.code, { filename: workflowBundle.filename });
    return new this(script, workflowBundle, isolateExecutionTimeoutMs, registeredActivityNames) as InstanceType<T>;
  }

  /**
   * Cleanup the pre-compiled script
   */
  public async destroy(): Promise<void> {
    globalHandlers.removeWorkflowBundle(this.workflowBundle);
    delete this._context;
  }
}

type WorkflowModule = typeof internals;

/**
 * A Workflow implementation using Node.js' built-in `vm` module
 */
export class ReusableVMWorkflow extends BaseVMWorkflow {
  public async dispose(): Promise<void> {
    ReusableVMWorkflowCreator.workflowByRunId.delete(this.runId);
  }
}
