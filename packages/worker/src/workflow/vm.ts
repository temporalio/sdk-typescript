import assert from 'node:assert';
import { URL, URLSearchParams } from 'node:url';
import { TextEncoder, TextDecoder } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';
import { IllegalStateError } from '@temporalio/common';
import { getTimeOfDay } from '@temporalio/core-bridge';
import { timeOfDayToBigint } from '../logger';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';
import {
  BaseVMWorkflow,
  globalHandlers,
  injectConsole,
  setUnhandledRejectionHandler,
  WorkflowModule,
} from './vm-shared';

/**
 * A WorkflowCreator that creates VMWorkflows in the current isolate
 */
export class VMWorkflowCreator implements WorkflowCreator {
  private static unhandledRejectionHandlerHasBeenSet = false;
  static workflowByRunId = new Map<string, VMWorkflow>();

  script?: vm.Script;

  constructor(
    script: vm.Script,
    protected readonly workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    protected readonly isolateExecutionTimeoutMs: number,
    protected readonly registeredActivityNames: Set<string>
  ) {
    if (!VMWorkflowCreator.unhandledRejectionHandlerHasBeenSet) {
      setUnhandledRejectionHandler((runId) => VMWorkflowCreator.workflowByRunId.get(runId));
      VMWorkflowCreator.unhandledRejectionHandlerHasBeenSet = true;
    }

    this.script = script;
  }

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const context = await this.getContext();
    this.injectConsole(context);
    const { isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            context.__TEMPORAL__.args = args;
            return vm.runInContext(`__TEMPORAL__.api.${fn}(...__TEMPORAL__.args)`, context, {
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
    const activator = context.__TEMPORAL_ACTIVATOR__ as any;

    const newVM = new VMWorkflow(options.info.runId, context, activator, workflowModule);
    VMWorkflowCreator.workflowByRunId.set(options.info.runId, newVM);
    return newVM;
  }

  protected async getContext(): Promise<vm.Context> {
    if (this.script === undefined) {
      throw new IllegalStateError('Isolate context provider was destroyed');
    }
    const globals = {
      AsyncLocalStorage,
      URL,
      URLSearchParams,
      assert,
      __webpack_module_cache__: {},
      TextEncoder,
      TextDecoder,
      AbortController,
    };
    const context = vm.createContext(globals, { microtaskMode: 'afterEvaluate' });
    this.script.runInContext(context);
    return context;
  }

  /**
   * Inject console.log and friends into a vm context.
   *
   * Overridable for test purposes.
   */
  protected injectConsole(context: vm.Context): void {
    injectConsole(context);
  }

  /**
   * Create a new instance, pre-compile scripts from given code.
   *
   * This method is generic to support subclassing.
   */
  public static async create<T extends typeof VMWorkflowCreator>(
    this: T,
    workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    isolateExecutionTimeoutMs: number,
    registeredActivityNames: Set<string>
  ): Promise<InstanceType<T>> {
    globalHandlers.install();
    await globalHandlers.addWorkflowBundle(workflowBundle);
    const script = new vm.Script(workflowBundle.code, { filename: workflowBundle.filename });
    return new this(script, workflowBundle, isolateExecutionTimeoutMs, registeredActivityNames) as InstanceType<T>;
  }

  /**
   * Cleanup the pre-compiled script
   */
  public async destroy(): Promise<void> {
    globalHandlers.removeWorkflowBundle(this.workflowBundle);
    delete this.script;
  }
}

/**
 * A Workflow implementation using Node.js' built-in `vm` module
 */
export class VMWorkflow extends BaseVMWorkflow {
  public async dispose(): Promise<void> {
    this.workflowModule.dispose();
    VMWorkflowCreator.workflowByRunId.delete(this.runId);
    delete this.context;
  }
}
