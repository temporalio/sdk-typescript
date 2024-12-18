import assert from 'node:assert';
import { URL, URLSearchParams } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
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
  _context?: vm.Context;
  /**
   * Store the global object keys we want to share between contexts
   */
  readonly contextKeysToPreserve: Set<string>;

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
    const globals = {
      AsyncLocalStorage,
      URL,
      URLSearchParams,
      assert,
      __webpack_module_cache__,
      TextEncoder,
      TextDecoder,
      AbortController,
    };
    this._context = vm.createContext(globals, { microtaskMode: 'afterEvaluate' });
    this.injectConsole();
    script.runInContext(this.context);
    this.contextKeysToPreserve = new Set(Object.keys(this.context));
    for (const v of sharedModules.values()) {
      deepFreeze(v);
    }
    for (const k of this.contextKeysToPreserve) {
      deepFreeze(this.context[k]);
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
    const bag: Record<string, unknown> = {};
    const { isolateExecutionTimeoutMs, contextKeysToPreserve } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            Object.assign(context, bag);
            // runInContext does not accept args, pass via globals
            context.__TEMPORAL_ARGS__ = args;
            try {
              return vm.runInContext(`__TEMPORAL__.api.${fn}(...__TEMPORAL_ARGS__)`, context, {
                timeout: isolateExecutionTimeoutMs,
                displayErrors: true,
              });
            } finally {
              const keysToDelete = [];
              // TODO: non-enumerable global properties?
              // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects
              for (const k in context) {
                if (!contextKeysToPreserve.has(k)) {
                  bag[k] = context[k];
                  context[k] = undefined;
                  keysToDelete.push(k);
                }
              }
              for (const k in keysToDelete) {
                delete context[k];
              }
              // Need to preserve this for the unhandledRejection handler.
              // TODO: There's probably a better way but this is simplest since we want to maintain compatibility with
              // the non-reusable vm implementation.
              context.__TEMPORAL_ACTIVATOR__ = bag.__TEMPORAL_ACTIVATOR__;
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
    const activator = bag.__TEMPORAL_ACTIVATOR__ as any;

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
