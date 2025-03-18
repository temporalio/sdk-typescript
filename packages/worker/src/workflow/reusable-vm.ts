import vm from 'node:vm';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { IllegalStateError } from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';
import { BaseVMWorkflow, globalHandlers, injectGlobals, setUnhandledRejectionHandler } from './vm-shared';

interface BagHolder {
  bag: any;
}

const callIntoVmScript = new vm.Script(`__TEMPORAL_CALL_INTO_SCOPE()`);

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
    vm.runInContext(
      `{
          const __TEMPORAL_CALL_INTO_SCOPE = () => {
            const [holder, fn, args] = globalThis.__TEMPORAL_ARGS__;
            delete globalThis.__TEMPORAL_ARGS__;

            if (globalThis.__TEMPORAL_BAG_HOLDER__ !== holder) {
              if (globalThis.__TEMPORAL_BAG_HOLDER__ !== undefined) {
                globalThis.__TEMPORAL_BAG_HOLDER__.bag = Object.getOwnPropertyDescriptors(globalThis);
              }

              // Start with all properties, and remove the ones that we see; the rest will be deleted
              const toBeDeleted = new Set(Reflect.ownKeys(globalThis));

              for (const prop of Reflect.ownKeys(holder.bag)) {
                if (holder.bag[prop].value !== globalThis[prop]) {
                  Object.defineProperty(globalThis, prop, holder.bag[prop]);
                }

                toBeDeleted.delete(prop);
              }

              // Delete extra properties, left from the former context
              for (const prop of toBeDeleted) {
                delete globalThis[prop];
              }

              globalThis.__TEMPORAL_BAG_HOLDER__ = holder;
            }

            return __TEMPORAL__.api[fn](...args);
          }
          Object.defineProperty(globalThis, '__TEMPORAL_CALL_INTO_SCOPE', { value: __TEMPORAL_CALL_INTO_SCOPE, writable: false, enumerable: false, configurable: false });
        }`,
      this._context,
      { timeout: isolateExecutionTimeoutMs, displayErrors: true }
    );

    this.injectGlobals(this._context);

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
   * Inject global objects as well as console.[log|...] into a vm context.
   *
   * Overridable for test purposes.
   */
  protected injectGlobals(context: vm.Context): void {
    injectGlobals(context);
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
            return callIntoVmScript.runInContext(context, {
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
      getTimeOfDay: native.getTimeOfDay,
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

/**
 * Call `Object.freeze()` recursively on an object.
 *
 * Note that there are limits to this approach, as traversing using getOwnPropertyXxx doesn't allow
 * reaching variables defined in internal scopes. That notably means that Map and Set classes,
 * are not frozen. Similarly, private properties and variables defined in closures are unreachable
 * and will therefore not be frozen. It is simply impossible to cover all potential cases.
 *
 * We also do not attempt to visit the prototype chain, as this would make it much harder to load
 * polyfills, and it is extremely unlikely anyway that one would modify the prototype of a built-in
 * object in a way that would have undesirable consequences (i.e. a polyfill function may actually
 * leak to another workflow context, but it wouldn't carry anything Workflow specific).
 *
 * This implementation is based on https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze.
 * Some implementatino decisions (e.g. freezing functions, not freezing prototypes, not handling Maps
 * and Sets, etc) are specific to the Reusable VM Workflow Sandbox use case, and may not be appropriate
 * for other use cases. For that reason, it is preferable to keep this function private to this module,
 * rather than exposing it as a reusable utility in the common package.
 */
function deepFreeze<T>(object: T, visited = new WeakSet<any>()): T {
  if (object == null || visited.has(object) || (typeof object !== 'object' && typeof object !== 'function'))
    return object;
  visited.add(object);
  if (Object.isFrozen(object)) return object;

  if (typeof object === 'object') {
    // Retrieve the property names defined on object
    const propNames = [...Object.getOwnPropertyNames(object), ...Object.getOwnPropertySymbols(object)];

    // Freeze properties before freezing self
    for (const name of propNames) {
      const value = (object as any)[name];

      if (value && (typeof value === 'object' || typeof value === 'function')) {
        try {
          deepFreeze(value, visited);
        } catch (_err) {
          // This is okay, for various reasons, some objects can't be frozen, e.g. Uint8Array.
        }
      }
    }
  }

  return Object.freeze(object);
}
