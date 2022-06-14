import { cutoffStackTrace, IllegalStateError } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import { WorkflowInfo } from '@temporalio/workflow';
import { SinkCall } from '@temporalio/workflow/lib/sinks';
import type * as internals from '@temporalio/workflow/lib/worker-interface';
import assert from 'assert';
import { AsyncLocalStorage } from 'async_hooks';
import semver from 'semver';
import { SourceMapConsumer } from 'source-map';
import vm from 'vm';
import v8 from 'v8';
import { partition } from '../utils';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';

interface ActivationContext {
  isReplaying: boolean;
}

// Not present in @types/node for some reason
const { promiseHooks } = v8 as any;

function getPromiseStackStore(promise: Promise<any>): internals.PromiseStackStore | undefined {
  // Access the global scope associated with the promise (unique per workflow - vm.context)
  // See for reference https://github.com/patriksimek/vm2/issues/32
  const ctor = promise.constructor.constructor;
  return ctor('return globalThis.__TEMPORAL__?.promiseStackStore')();
}

// Best effort to catch unhandled rejections from workflow code.
// We crash the thread if we cannot find the culprit.
export function setUnhandledRejectionHandler(): void {
  process.on('unhandledRejection', (err, promise) => {
    // Get the runId associated with the vm context.
    // See for reference https://github.com/patriksimek/vm2/issues/32
    const ctor = promise.constructor.constructor;
    const runId = ctor('return globalThis.__TEMPORAL__?.runId')();
    if (runId !== undefined) {
      const workflow = VMWorkflowCreator.workflowByRunId.get(runId);
      if (workflow !== undefined) {
        workflow.setUnhandledRejection(err);
        return;
      }
    }
    // The user's logger is not accessible in this thread,
    // dump the error information to stderr and abort.
    console.error('Unhandled rejection', { runId }, err);
    process.exit(1);
  });
}

/**
 * A WorkflowCreator that creates VMWorkflows in the current isolate
 */
export class VMWorkflowCreator implements WorkflowCreator {
  private static unhandledRejectionHandlerHasBeenSet = false;
  static workflowByRunId = new Map<string, VMWorkflow>();
  readonly hasSeparateMicrotaskQueue: boolean;

  script?: vm.Script;

  constructor(script: vm.Script, public readonly sourceMap: string, public readonly isolateExecutionTimeoutMs: number) {
    if (!VMWorkflowCreator.unhandledRejectionHandlerHasBeenSet) {
      setUnhandledRejectionHandler();
      VMWorkflowCreator.unhandledRejectionHandlerHasBeenSet = true;
    }

    // https://nodejs.org/api/vm.html#vmcreatecontextcontextobject-options
    // microtaskMode=afterEvaluate was added in 14.6.0
    this.hasSeparateMicrotaskQueue = semver.gte(process.versions.node, '14.6.0');

    this.script = script;
  }

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const context = await this.getContext();
    const activationContext = { isReplaying: options.isReplaying };
    this.injectConsole(context, options.info, activationContext);
    const { hasSeparateMicrotaskQueue, isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            context.args = args;
            const ret = vm.runInContext(`__TEMPORAL__.api.${fn}(...globalThis.args)`, context, {
              timeout: isolateExecutionTimeoutMs,
              displayErrors: true,
            });
            // When running with microtaskMode `afterEvaluate`, promises from context cannot be directly awaited outside of it.
            if (
              hasSeparateMicrotaskQueue &&
              typeof ret === 'object' &&
              ret != null &&
              ret.constructor.name === 'Promise'
            ) {
              return new Promise((resolve, reject) => ret.then(resolve, reject));
            }
            return ret;
          };
        },
      }
    ) as any;

    await workflowModule.initRuntime(options);

    const newVM = new VMWorkflow(
      options.info,
      context,
      workflowModule,
      isolateExecutionTimeoutMs,
      this.hasSeparateMicrotaskQueue,
      activationContext
    );
    VMWorkflowCreator.workflowByRunId.set(options.info.runId, newVM);
    return newVM;
  }

  protected async getContext(): Promise<vm.Context> {
    if (this.script === undefined) {
      throw new IllegalStateError('Isolate context provider was destroyed');
    }
    let context;
    if (this.hasSeparateMicrotaskQueue) {
      context = vm.createContext(
        { AsyncLocalStorage, assert, activePromises: new Set() },
        { microtaskMode: 'afterEvaluate' }
      );
    } else {
      context = vm.createContext({ AsyncLocalStorage, assert, activePromises: new Set() });
    }
    this.script.runInContext(context);
    return context;
  }

  /**
   * Inject console.log into the Workflow isolate context.
   *
   * Overridable for test purposes.
   */
  protected injectConsole(context: vm.Context, info: WorkflowInfo, ac: ActivationContext): void {
    context.console = {
      log: (...args: any[]) => {
        // isReplaying is mutated by the Workflow class on activation
        if (ac.isReplaying) return;
        console.log(`[${info.workflowType}(${info.workflowId})]`, ...args);
      },
    };
  }

  /**
   * Create a new instance, pre-compile scripts from given code.
   *
   * This method is generic to support subclassing.
   */
  public static async create<T extends typeof VMWorkflowCreator>(
    this: T,
    code: string,
    sourceMap: string,
    isolateExecutionTimeoutMs: number
  ): Promise<InstanceType<T>> {
    const script = new vm.Script(code, { filename: 'workflow-isolate' });
    const sourceMapConsumer = await new SourceMapConsumer(JSON.parse(sourceMap));

    // Augment the global vm Error stack trace prepare function
    // NOTE: this means that multiple instances of this class in the same VM
    // will override each other.
    // This should be a non-issue in most cases since we typically construct a single instance of
    // this class per Worker thread.
    Error.prepareStackTrace = (err, stackTraces) => {
      const converted = stackTraces.map((callsite) => {
        const line = callsite.getLineNumber();
        const column = callsite.getColumnNumber();
        if (callsite.getFileName() === 'workflow-isolate' && line && column) {
          const pos = sourceMapConsumer.originalPositionFor({ line, column });

          const typeName = callsite.getTypeName();
          const methodName = callsite.getMethodName();
          const functionName = callsite.getFunctionName();
          const isConstructor = callsite.isConstructor();

          const name =
            pos.name ||
            (typeName && methodName
              ? `${callsite.getTypeName()}.${callsite.getMethodName()}`
              : isConstructor && functionName
              ? `new ${functionName}`
              : functionName);
          return name
            ? `    at ${name} (${pos.source}:${pos.line}:${pos.column})`
            : `    at ${pos.source}:${pos.line}:${pos.column}`;
        } else {
          return `    at ${callsite}`;
        }
      });
      return `${err}\n${converted.join('\n')}`;
    };

    // Track Promise aggregators like `race` and `all` to link their internally created promises
    let currentAggregation: Promise<unknown> | undefined = undefined;

    // This also is set globally for the isolate which unless the worker is run in debug mode is insignificant
    if (promiseHooks) {
      // Node >=16.14 only
      promiseHooks.createHook({
        init(promise: Promise<unknown>, parent: Promise<unknown>) {
          // Only run in workflow context
          const store = getPromiseStackStore(promise);
          if (!store) return;
          let stackTrace = cutoffStackTrace(
            new Error().stack?.replace(
              /^Error\n\s*at [^\n]+\n(\s*at initAll \(node:internal\/promise_hooks:\d+:\d+\)\n)?/,
              ''
            )
          );
          // To see the full stack replace with commented line
          // stackTrace = new Error().stack?.replace(/^Error\n\s*at [^\n]+\n(\s*at initAll \(node:internal\/promise_hooks:\d+:\d+\)\n)?/, '')!;

          if (
            currentAggregation &&
            /^\s+at\sPromise\.then \(<anonymous>\)\n\s+at Function\.(race|all|allSettled|any) \(<anonymous>\)\n/.test(
              stackTrace
            )
          ) {
            // Skip internal promises created by the aggregator and link directly.
            promise = currentAggregation;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            stackTrace = store.promiseToStack.get(currentAggregation)!; // Must exist
          } else if (/^\s+at Function\.(race|all|allSettled|any) \(<anonymous>\)\n/.test(stackTrace)) {
            currentAggregation = promise;
          } else {
            currentAggregation = undefined;
          }
          // This is weird but apparently it happens
          if (promise === parent) {
            return;
          }

          store.promiseToStack.set(promise, stackTrace);
          // In case of Promise.race and friends we might have multiple "parents"
          const parents = store.childToParent.get(promise) ?? new Set();
          if (parent) {
            parents.add(parent);
          }
          store.childToParent.set(promise, parents);
        },
        settled(promise: Promise<unknown>) {
          // Only run in workflow context
          const store = getPromiseStackStore(promise);
          if (!store) return;
          store.childToParent.delete(promise);
          store.promiseToStack.delete(promise);
        },
      });
    }

    return new this(script, sourceMap, isolateExecutionTimeoutMs) as InstanceType<T>;
  }

  /**
   * Cleanup the pre-compiled script
   */
  public async destroy(): Promise<void> {
    delete this.script;
  }
}

type WorkflowModule = typeof internals;

/**
 * A Workflow implementation using Node.js' built-in `vm` module
 */
export class VMWorkflow implements Workflow {
  unhandledRejection: unknown;

  constructor(
    public readonly info: WorkflowInfo,
    protected context: vm.Context | undefined,
    readonly workflowModule: WorkflowModule,
    public readonly isolateExecutionTimeoutMs: number,
    public readonly hasSeparateMicrotaskQueue: boolean,
    public readonly activationContext: ActivationContext
  ) {}

  /**
   * Send request to the Workflow runtime's worker-interface
   */
  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    return this.workflowModule.getAndResetSinkCalls();
  }

  /**
   * Send request to the Workflow runtime's worker-interface
   *
   * The Workflow is activated in batches to ensure correct order of activation
   * job application.
   */
  public async activate(activation: coresdk.workflow_activation.IWorkflowActivation): Promise<Uint8Array> {
    if (this.context === undefined) {
      throw new IllegalStateError('Workflow isolate context uninitialized');
    }
    this.activationContext.isReplaying = activation.isReplaying ?? false;
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }

    // Job processing order
    // 1. patch notifications
    // 2. signals
    // 3. anything left except for queries
    // 4. queries
    const [patches, nonPatches] = partition(activation.jobs, ({ notifyHasPatch }) => notifyHasPatch != null);
    const [signals, nonSignals] = partition(nonPatches, ({ signalWorkflow }) => signalWorkflow != null);
    const [queries, rest] = partition(nonSignals, ({ queryWorkflow }) => queryWorkflow != null);
    let batchIndex = 0;

    // Loop and invoke each batch and wait for microtasks to complete.
    // This is done outside of the isolate because when we used isolated-vm we couldn't wait for microtasks from inside the isolate, not relevant anymore.
    for (const jobs of [patches, signals, rest, queries]) {
      if (jobs.length === 0) {
        continue;
      }
      this.workflowModule.activate(
        coresdk.workflow_activation.WorkflowActivation.fromObject({ ...activation, jobs }),
        batchIndex++
      );
      await this.tryUnblockConditions();
    }
    const completion = this.workflowModule.concludeActivation();
    // Give unhandledRejection handler a chance to be triggered.
    await new Promise(setImmediate);
    if (this.unhandledRejection) {
      return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited({
        runId: activation.runId,
        failed: { failure: this.workflowModule.errorToFailure(this.unhandledRejection) },
      }).finish();
    }
    return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(completion).finish();
  }

  /**
   * If called (by an external unhandledRejection handler), activations will fail with provided error.
   */
  public setUnhandledRejection(err: unknown): void {
    this.unhandledRejection = err;
  }

  /**
   * Call into the Workflow context to attempt to unblock any blocked conditions.
   *
   * This is performed in a loop allowing microtasks to be processed between
   * each iteration until there are no more conditions to unblock.
   */
  protected async tryUnblockConditions(): Promise<void> {
    for (;;) {
      if (!this.hasSeparateMicrotaskQueue) {
        // Wait for microtasks to be processed
        // This is only required if the context doesn't have a separate microtask queue
        // because when it does we guarantee to wait for microtasks to be processed every
        // time we enter the context.
        await new Promise(setImmediate);
      }
      const numUnblocked = this.workflowModule.tryUnblockConditions();
      if (numUnblocked === 0) break;
    }
  }

  /**
   * Dispose of the isolate's context.
   * Do not use this Workflow instance after this method has been called.
   */
  public async dispose(): Promise<void> {
    VMWorkflowCreator.workflowByRunId.delete(this.info.runId);
    await this.workflowModule.dispose();
    delete this.context;
  }
}
