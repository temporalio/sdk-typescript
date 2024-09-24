import v8 from 'node:v8';
import vm from 'node:vm';
import { SourceMapConsumer } from 'source-map';
import { cutoffStackTrace, IllegalStateError } from '@temporalio/common';
import { tsToMs } from '@temporalio/common/lib/time';
import { coresdk } from '@temporalio/proto';
import type { StackTraceFileLocation } from '@temporalio/workflow';
import { type SinkCall } from '@temporalio/workflow/lib/sinks';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { Activator } from '@temporalio/workflow/lib/internals';
import { SdkFlags } from '@temporalio/workflow/lib/flags';
import { Workflow } from './interface';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';

// Not present in @types/node for some reason
const { promiseHooks } = v8 as any;

// Best effort to catch unhandled rejections from workflow code.
// We crash the thread if we cannot find the culprit.
export function setUnhandledRejectionHandler(getWorkflowByRunId: (runId: string) => BaseVMWorkflow | undefined): void {
  process.on('unhandledRejection', (err, promise) => {
    const activator = getActivator(promise);
    const runId = activator?.info?.runId;
    if (runId !== undefined) {
      const workflow = getWorkflowByRunId(runId);
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
 * Variant of {@link cutoffStackTrace} that works with FileLocation, keep this in sync with the original implementation
 */
function cutoffStructuredStackTrace(stackTrace: StackTraceFileLocation[]): void {
  stackTrace.shift();
  if (stackTrace[0].function_name === 'initAll' && stackTrace[0].file_path === 'node:internal/promise_hooks') {
    stackTrace.shift();
  }
  const idx = stackTrace.findIndex(({ function_name, file_path }) => {
    return (
      function_name &&
      file_path &&
      ((/^Activator\.\S+NextHandler$/.test(function_name) &&
        /.*[\\/]workflow[\\/](?:src|lib)[\\/]internals\.[jt]s$/.test(file_path)) ||
        (/Script\.runInContext/.test(function_name) && /^node:vm|vm\.js$/.test(file_path)))
    );
  });
  if (idx > -1) {
    stackTrace.splice(idx);
  }
}

function getActivator(promise: Promise<any>): Activator | undefined {
  // Access the global scope associated with the promise (unique per workflow - vm.context)
  // See for reference https://github.com/patriksimek/vm2/issues/32
  const ctor = promise.constructor.constructor;
  return ctor('return globalThis.__TEMPORAL_ACTIVATOR__')();
}

/**
 * Internal helper to format callsite "name" portion in stack trace
 */
function formatCallsiteName(callsite: NodeJS.CallSite): string | null {
  const typeName = callsite.getTypeName();
  const methodName = callsite.getMethodName();
  const functionName = callsite.getFunctionName();
  const isConstructor = callsite.isConstructor();

  return typeName && methodName
    ? `${typeName}.${methodName}`
    : isConstructor && functionName
      ? `new ${functionName}`
      : functionName;
}

/**
 * Inject console.log and friends into a vm context.
 */
export function injectConsole(context: vm.Context): void {
  const consoleMethods = ['log', 'warn', 'error', 'info', 'debug'] as const;
  type ConsoleMethod = (typeof consoleMethods)[number];
  function makeConsoleFn(level: ConsoleMethod) {
    return function (...args: unknown[]) {
      const { info } = context.__TEMPORAL_ACTIVATOR__;
      if (info.isReplaying) return;
      console[level](`[${info.workflowType}(${info.workflowId})]`, ...args);
    };
  }
  context.console = Object.fromEntries(consoleMethods.map((level) => [level, makeConsoleFn(level)]));
}

/**
 * Global handlers for overriding stack trace preparation and promise hooks
 */
export class GlobalHandlers {
  currentStackTrace: StackTraceFileLocation[] | undefined = undefined;
  bundleFilenameToSourceMapConsumer = new Map<string, SourceMapConsumer>();
  origPrepareStackTrace = Error.prepareStackTrace;
  private stopPromiseHook = () => {
    // noop
  };
  installed = false;

  async addWorkflowBundle(workflowBundle: WorkflowBundleWithSourceMapAndFilename): Promise<void> {
    const sourceMapConsumer = await new SourceMapConsumer(workflowBundle.sourceMap);
    this.bundleFilenameToSourceMapConsumer.set(workflowBundle.filename, sourceMapConsumer);
  }

  removeWorkflowBundle(workflowBundle: WorkflowBundleWithSourceMapAndFilename): void {
    this.bundleFilenameToSourceMapConsumer.delete(workflowBundle.filename);
  }

  /**
   * Set the global hooks, this method is idempotent
   */
  install(): void {
    if (!this.installed) {
      this.overridePrepareStackTrace();
      this.setPromiseHook();
      this.installed = true;
    }
  }

  /**
   * Unset all installed global hooks
   *
   * This method is not called anywhere since we typically install the hooks in a separate thread which is cleaned up
   * after worker shutdown. Is debug mode we don't clean these up but that should be insignificant.
   */
  uninstall(): void {
    this.stopPromiseHook();
    Error.prepareStackTrace = this.origPrepareStackTrace;
    this.installed = false;
  }

  private overridePrepareStackTrace(): void {
    const OuterError = Error;
    // Augment the vm-global Error stack trace prepare function
    // NOTE: this means that multiple instances of this class in the same VM
    // will override each other.
    // This should be a non-issue in most cases since we typically construct a single instance of
    // this class per Worker thread.
    // See: https://v8.dev/docs/stack-trace-api#customizing-stack-traces
    Error.prepareStackTrace = (err, stackTraces) => {
      const inWorkflowContext = OuterError !== err.constructor;
      if (this.origPrepareStackTrace && !inWorkflowContext) {
        return this.origPrepareStackTrace(err, stackTraces);
      }
      // Set the currentStackTrace so it can be used in the promise `init` hook below
      this.currentStackTrace = [];
      const converted = stackTraces.map((callsite) => {
        const line = callsite.getLineNumber();
        const column = callsite.getColumnNumber();
        const filename = callsite.getFileName();
        const sourceMapConsumer = filename && this.bundleFilenameToSourceMapConsumer.get(filename);
        if (sourceMapConsumer && line && column) {
          const pos = sourceMapConsumer.originalPositionFor({ line, column });

          const name = pos.name || formatCallsiteName(callsite);
          this.currentStackTrace?.push({
            file_path: pos.source ?? undefined,
            function_name: name ?? undefined,
            line: pos.line ?? undefined,
            column: pos.column ?? undefined,
            internal_code: false,
          });

          return name
            ? `    at ${name} (${pos.source}:${pos.line}:${pos.column})`
            : `    at ${pos.source}:${pos.line}:${pos.column}`;
        } else {
          const name = formatCallsiteName(callsite);

          this.currentStackTrace?.push({
            file_path: filename ?? undefined,
            function_name: name ?? undefined,
            line: line ?? undefined,
            column: column ?? undefined,
            internal_code: false,
          });
          return `    at ${callsite}`;
        }
      });
      return `${err}\n${converted.join('\n')}`;
    };
  }

  private setPromiseHook(): void {
    // Track Promise aggregators like `race` and `all` to link their internally created promises
    let currentAggregation: Promise<unknown> | undefined = undefined;

    // This also is set globally for the isolate (worker thread), which is insignificant unless the worker is run in debug mode
    if (promiseHooks) {
      // Node >=16.14 only
      this.stopPromiseHook = promiseHooks.createHook({
        init: (promise: Promise<unknown>, parent: Promise<unknown>) => {
          // Only run in workflow context
          const activator = getActivator(promise);
          if (!activator) return;
          const store = activator.promiseStackStore;
          // TODO: hide this somehow: defineProperty + symbol
          (promise as any).runId = activator.info.runId;
          // Reset currentStackTrace just in case (it will be set in `prepareStackTrace` above)
          this.currentStackTrace = undefined;
          const fn = promise.constructor.constructor;
          const ErrorCtor = fn('return globalThis.Error')();

          // To see the full stack replace with commented line
          // const formatted = new ErrorCtor().stack?.replace(/^Error\n\s*at [^\n]+\n(\s*at initAll \(node:internal\/promise_hooks:\d+:\d+\)\n)?/, '')!;
          const formatted = cutoffStackTrace(
            new ErrorCtor().stack?.replace(
              /^Error\n\s*at [^\n]+\n(\s*at initAll \(node:internal\/promise_hooks:\d+:\d+\)\n)?/,
              ''
            )
          );
          if (this.currentStackTrace === undefined) {
            return;
          }
          const structured = this.currentStackTrace as StackTraceFileLocation[];
          cutoffStructuredStackTrace(structured);
          let stackTrace = { formatted, structured };

          if (
            currentAggregation &&
            /^\s+at\sPromise\.then \(<anonymous>\)\n\s+at Function\.(race|all|allSettled|any) \(<anonymous>\)\n/.test(
              formatted
            )
          ) {
            // Skip internal promises created by the aggregator and link directly.
            promise = currentAggregation;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            stackTrace = store.promiseToStack.get(currentAggregation)!; // Must exist
          } else if (/^\s+at Function\.(race|all|allSettled|any) \(<anonymous>\)\n/.test(formatted)) {
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
          const store = getActivator(promise)?.promiseStackStore;
          if (!store) return;
          store.childToParent.delete(promise);
          store.promiseToStack.delete(promise);
        },
      });
    }
  }
}

export const globalHandlers = new GlobalHandlers();

export type WorkflowModule = typeof internals;

/**
 * A Workflow implementation using Node.js' built-in `vm` module.
 */
export abstract class BaseVMWorkflow implements Workflow {
  unhandledRejection: unknown;

  constructor(
    readonly runId: string,
    protected context: vm.Context | undefined,
    protected activator: Activator,
    readonly workflowModule: WorkflowModule
  ) {}

  /**
   * Send request to the Workflow runtime's worker-interface
   */
  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    return this.activator.getAndResetSinkCalls();
  }

  /**
   * Send request to the Workflow runtime's worker-interface
   */
  public async activate(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
    if (this.context === undefined) throw new IllegalStateError('Workflow isolate context uninitialized');
    activation = coresdk.workflow_activation.WorkflowActivation.fromObject(activation);
    if (!activation.jobs) throw new TypeError('Expected workflow activation jobs to be defined');

    // Queries are particular in many ways, and Core guarantees that a single activation will not
    // contain both queries and other jobs. So let's handle them separately.
    const [queries, nonQueries] = partition(activation.jobs, ({ queryWorkflow }) => queryWorkflow != null);
    if (queries.length > 0) {
      if (nonQueries.length > 0) throw new TypeError('Got both queries and other jobs in a single activation');
      return this.activateQueries(activation);
    }

    // Update the activator's state in preparation for a non-query activation.
    // This is done early, so that we can then rely on the activator while processing the activation.
    if (activation.timestamp == null)
      throw new TypeError('Expected activation.timestamp to be set for non-query activation');
    this.activator.now = tsToMs(activation.timestamp);
    this.activator.mutateWorkflowInfo((info) => ({
      ...info,
      historyLength: activation.historyLength as number,
      // Exact truncation for multi-petabyte histories
      // historySize === 0 means WFT was generated by pre-1.20.0 server, and the history size is unknown
      historySize: activation.historySizeBytes?.toNumber() ?? 0,
      continueAsNewSuggested: activation.continueAsNewSuggested ?? false,
      currentBuildId: activation.buildIdForCurrentTask ?? undefined,
      unsafe: {
        ...info.unsafe,
        isReplaying: activation.isReplaying ?? false,
      },
    }));
    this.activator.addKnownFlags(activation.availableInternalFlags ?? []);

    // Initialization of the workflow must happen before anything else. Yet, keep the init job in
    // place in the list as we'll use it as a marker to know when to start the workflow function.
    const initWorkflowJob = activation.jobs.find((job) => job.initializeWorkflow != null)?.initializeWorkflow;
    if (initWorkflowJob) this.workflowModule.initialize(initWorkflowJob);

    const hasSignals = activation.jobs.some(({ signalWorkflow }) => signalWorkflow != null);
    const doSingleBatch = !hasSignals || this.activator.hasFlag(SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch);

    const [patches, nonPatches] = partition(activation.jobs, ({ notifyHasPatch }) => notifyHasPatch != null);
    for (const { notifyHasPatch } of patches) {
      if (notifyHasPatch == null) throw new TypeError('Expected notifyHasPatch to be set');
      this.activator.notifyHasPatch(notifyHasPatch);
    }

    if (doSingleBatch) {
      // updateRandomSeed requires the same special handling as patches (before anything else, and don't
      // unblock conditions after each job). Unfortunately, prior to ProcessWorkflowActivationJobsAsSingleBatch,
      // they were handled as regular jobs, making it unsafe to properly handle that job above, with patches.
      const [updateRandomSeed, rest] = partition(nonPatches, ({ updateRandomSeed }) => updateRandomSeed != null);
      if (updateRandomSeed.length > 0)
        this.activator.updateRandomSeed(updateRandomSeed[updateRandomSeed.length - 1].updateRandomSeed!);
      this.workflowModule.activate(
        coresdk.workflow_activation.WorkflowActivation.fromObject({ ...activation, jobs: rest })
      );
      this.tryUnblockConditionsAndMicrotasks();
    } else {
      const [signals, nonSignals] = partition(
        nonPatches,
        // Move signals to a first batch; all the rest goes in a second batch.
        ({ signalWorkflow }) => signalWorkflow != null
      );

      // Loop and invoke each batch, waiting for microtasks to complete after each batch.
      let batchIndex = 0;
      for (const jobs of [signals, nonSignals]) {
        if (jobs.length === 0) continue;
        this.workflowModule.activate(
          coresdk.workflow_activation.WorkflowActivation.fromObject({ ...activation, jobs }),
          batchIndex++
        );
        this.tryUnblockConditionsAndMicrotasks();
      }
    }

    const completion = this.workflowModule.concludeActivation();

    // Give unhandledRejection handler a chance to be triggered.
    await new Promise(setImmediate);
    if (this.unhandledRejection) {
      return {
        runId: this.activator.info.runId,
        // FIXME: Calling `activator.errorToFailure()` directly from outside the VM is unsafe, as it
        // depends on the `failureConverter` and `payloadConverter`, which may be customized and
        // therefore aren't guaranteed not to access `global` or to cause scheduling microtasks.
        // Admitingly, the risk is very low, so we're leaving it as is for now.
        failed: { failure: this.activator.errorToFailure(this.unhandledRejection) },
      };
    }
    return completion;
  }

  private activateQueries(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): coresdk.workflow_completion.IWorkflowActivationCompletion {
    this.activator.mutateWorkflowInfo((info) => ({
      ...info,
      unsafe: {
        ...info.unsafe,
        isReplaying: true,
      },
    }));
    this.workflowModule.activate(activation);
    return this.workflowModule.concludeActivation();
  }

  /**
   * If called (by an external unhandledRejection handler), activations will fail with provided error.
   */
  public setUnhandledRejection(err: unknown): void {
    this.unhandledRejection = err;
  }

  /**
   * Call into the Workflow context to attempt to unblock any blocked conditions and microtasks.
   *
   * This is performed in a loop allowing microtasks to be processed between
   * each iteration until there are no more conditions to unblock.
   */
  protected tryUnblockConditionsAndMicrotasks(): void {
    for (;;) {
      const numUnblocked = this.workflowModule.tryUnblockConditions();
      if (numUnblocked === 0) break;
    }
  }

  /**
   * Do not use this Workflow instance after this method has been called.
   */
  public abstract dispose(): Promise<void>;
}

function partition<T>(arr: T[], predicate: (x: T) => boolean): [T[], T[]] {
  const truthy = Array<T>();
  const falsy = Array<T>();
  arr.forEach((v) => (predicate(v) ? truthy : falsy).push(v));
  return [truthy, falsy];
}
