import assert from 'node:assert';
import { URL, URLSearchParams } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { IllegalStateError } from '@temporalio/common';
import { deepFreeze } from '@temporalio/common/lib/type-helpers';
import { getTimeOfDay } from '@temporalio/core-bridge';
import { timeOfDayToBigint } from '../logger';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';
import { BaseVMWorkflow, globalHandlers, injectConsole, setUnhandledRejectionHandler } from './vm-shared';

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
  private pristine?: Map<string, PropertyDescriptor>;

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
    const globals = { AsyncLocalStorage, URL, URLSearchParams, assert, __webpack_module_cache__ };
    this._context = vm.createContext(globals, { microtaskMode: 'afterEvaluate' });
    this.injectConsole();
    script.runInContext(this.context);

    this.pristine = new Map<string, PropertyDescriptor>();
    (globals as any).__pristine = this.pristine;
    // The V8 context is really composed of two distinct objects: the `globals` object defined above
    // on the outside, and another internal object to which we only have access from the inside, which
    // defines the built-in global properties. We need
    vm.runInContext(
      `
        const pristine = globalThis.__pristine;
        delete globalThis.__pristine;
        for (const name of Object.getOwnPropertyNames(globalThis)) {
          const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
          pristine.set(name, descriptor);
        }
      `,
      this.context
    );
    for (const [k, v] of this.pristine.entries()) {
      if (k !== 'globalThis') {
        deepFreeze(v.value);
      }
    }
    for (const v of sharedModules.values()) {
      deepFreeze(v);
    }
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
    const pristine = this.pristine;
    const bag: Map<string, PropertyDescriptor> = new Map();
    const { isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            for (const [pname, pdesc] of bag.entries()) {
              Object.defineProperty(context, pname, pdesc);
            }

            // runInContext does not accept args, pass via globals
            context.__TEMPORAL_ARGS__ = args;
            try {
              // By the time we get out of this call, all microtasks will have been executed
              return vm.runInContext(`__TEMPORAL__.api.${fn}(...__TEMPORAL_ARGS__)`, context, {
                timeout: isolateExecutionTimeoutMs,
                displayErrors: true,
              });
            } finally {
              // No need to keep that one
              delete context.__TEMPORAL_ARGS__;

              //
              bag.clear();
              const keysToCleanup: [string, PropertyDescriptor | undefined][] = [];

              for (const pname of Object.getOwnPropertyNames(context)) {
                const pdesc = Object.getOwnPropertyDescriptor(context, pname) as PropertyDescriptor;
                const pdescPristine = pristine?.get(pname);
                if (pdesc.value !== pdescPristine?.value) {
                  bag.set(pname, pdesc);
                  keysToCleanup.push([pname, pdescPristine]);
                }
              }

              // Looks like Node/V8 is not properly syncing deletion of keys on the outter context
              // object to the inner globalThis object. Hence, we delete them from inside the context.
              context.__TEMPORAL_ARGS__ = keysToCleanup;
              vm.runInContext(
                `
                  for (const [name, descriptor] of globalThis.__TEMPORAL_ARGS__) {
                    delete globalThis[name];
                    if (descriptor) {
                      Object.defineProperty(globalThis, name, descriptor);
                    }
                  }
                  delete globalThis.__TEMPORAL_ARGS__;`,
                context
              );

              // Need to preserve this for the unhandledRejection handler.
              // TODO: There's probably a better way but this is simplest since we want to maintain compatibility with
              // the non-reusable vm implementation.
              context.__TEMPORAL_ACTIVATOR__ = bag.get('__TEMPORAL_ACTIVATOR__')?.value;
            }
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
    const activator = bag.get('__TEMPORAL_ACTIVATOR__')?.value as any;
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
