import v8 from 'node:v8';
import vm from 'node:vm';
import { AsyncLocalStorage as AsyncLocalStorageOriginal } from 'node:async_hooks';
import assert from 'node:assert';
import { atob, btoa } from 'node:buffer';
import * as nodeUrl from 'node:url';
import { URL, URLSearchParams } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
import { SourceMapConsumer } from 'source-map';
import { cutoffStackTrace, IllegalStateError, convertDeploymentVersion } from '@temporalio/common';
import { suggestContinueAsNewReasonsFromProto } from '@temporalio/common/lib/continue-as-new';
import { tsToMs } from '@temporalio/common/lib/time';
import { coresdk } from '@temporalio/proto';
import type { StackTraceFileLocation } from '@temporalio/workflow';
import { type SinkCall } from '@temporalio/workflow/lib/sinks';
import type * as internals from '@temporalio/workflow/lib/worker-interface';
import type { Activator } from '@temporalio/workflow/lib/internals';
import { SdkFlags } from '@temporalio/workflow/lib/flags';
import { UnhandledRejectionError } from '../errors';
import type { Workflow } from './interface';
import type { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';

// We need this import for the ambient global extensions
import '@temporalio/workflow/lib/global-attributes'; // eslint-disable-line import/no-unassigned-import
import { isBunPre1_4 } from './bun';

// Best effort to catch unhandled rejections from workflow code.
// We crash the thread if we cannot find the culprit.
export function setUnhandledRejectionHandler(getWorkflowByRunId: (runId: string) => BaseVMWorkflow | undefined): void {
  process.on('unhandledRejection', (err, promise) => {
    const activator = getActivator(promise);
    const runId = activator?.info?.runId;
    if (runId !== undefined) {
      const workflow = getWorkflowByRunId(runId);
      if (workflow !== undefined) {
        workflow.setUnhandledRejection(new UnhandledRejectionError(`Unhandled Promise rejection: ${err}`, err));
        return;
      }
    }

    console.error('An Unhandled Promise rejection could not be associated to a Workflow Run', { runId, error: err });
    throw new UnhandledRejectionError(
      `Unhandled Promise rejection for unknown Workflow Run id='${runId}': ${err}`,
      err
    );
  });
}

/**
 * Replace Node's generic VM timeout error with the TMPRL1101 deadlock diagnostic shared by all Temporal SDKs,
 * so that users can find and act on it. Other errors are returned unchanged.
 */
export function toDeadlockErrorIfVmTimeout(err: unknown, isolateExecutionTimeoutMs: number): unknown {
  if ((err as { code?: unknown } | null)?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') return err;
  const timeoutError = err as Error;
  const deadlockError = new Error(
    `[TMPRL1101] Potential deadlock detected: workflow didn't yield within ${isolateExecutionTimeoutMs}ms ` +
      `(${timeoutError.message}). Workflow code must not block, busy-loop, or run long CPU-bound work ` +
      `without awaiting. See https://github.com/temporalio/rules/blob/main/rules/TMPRL1101.md`
  );
  // Reuse Node's stack so the failure recorded in history doesn't gain the worker's own frames.
  deadlockError.stack = timeoutError.stack?.replace(timeoutError.message, () => deadlockError.message);
  return deadlockError;
}

/**
 * Variant of {@link cutoffStackTrace} that works with FileLocation, keep this in sync with the original implementation
 */
function cutoffStructuredStackTrace(stackTrace: StackTraceFileLocation[]): void {
  stackTrace.shift();
  if (stackTrace[0]?.function_name === 'initAll' && stackTrace[0].file_path === 'node:internal/promise_hooks') {
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

/**
 * Return the `Function` constructor of the realm (vm.Context) that created `promise`, or `undefined` if it can't be
 * determined.
 *
 * The promise hooks and the unhandled rejection handler see every promise in the isolate, not only workflow promises.
 * Code outside a workflow can give a promise any `constructor`: user code can assign one, and Node's own WebCrypto
 * (since v26.11) sets `constructor` to `undefined` on its internal job promises. Reading the constructor from the
 * prototype ignores such own properties, and the `typeof` checks reject anything that isn't a constructor.
 */
function getPromiseRealmFunction(promise: Promise<unknown>): FunctionConstructor | undefined {
  const promiseCtor = Object.getPrototypeOf(promise)?.constructor;
  if (typeof promiseCtor !== 'function') return undefined;
  const fnCtor = promiseCtor.constructor;
  return typeof fnCtor === 'function' ? fnCtor : undefined;
}

function getActivator(promise: Promise<any>): Activator | undefined {
  // Access the global scope associated with the promise (unique per workflow - vm.context)
  // See for reference https://github.com/patriksimek/vm2/issues/32
  const ctor = getPromiseRealmFunction(promise);
  if (ctor === undefined) return undefined;
  try {
    return ctor('return globalThis.__TEMPORAL_ACTIVATOR__')();
  } catch {
    // A promise from outside any workflow; never let the hook throw on it.
    return undefined;
  }
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
 * Inject global objects as well as console.[log|...] into a vm context.
 */
export function injectGlobals(context: vm.Context): void {
  const sandboxGlobalThis = context as typeof globalThis;

  const globals: Record<string, unknown> = {
    URL,
    URLSearchParams,
    assert,
    TextEncoder,
    TextDecoder,
    AbortController,
    atob,
    btoa,
  };
  // URLPattern is only available on Node 23.8+; leave it undefined in the sandbox on older versions.
  const URLPattern = (nodeUrl as { URLPattern?: unknown }).URLPattern;
  if (URLPattern !== undefined) {
    globals.URLPattern = URLPattern;
  }
  for (const [k, v] of Object.entries(globals)) {
    Object.defineProperty(sandboxGlobalThis, k, { value: v, writable: false, enumerable: true, configurable: false });
  }

  const consoleMethods = ['log', 'warn', 'error', 'info', 'debug'] as const;
  type ConsoleMethod = (typeof consoleMethods)[number];
  function makeConsoleFn(level: ConsoleMethod) {
    return function (...args: unknown[]) {
      if (sandboxGlobalThis.__TEMPORAL_ACTIVATOR__ === undefined) {
        // This should not happen in a normal execution environment, but this is
        // often handy while debugging the SDK, and costs nothing to keep around.
        console[level](`[not in workflow context]`, ...args);
      } else {
        const { info } = sandboxGlobalThis.__TEMPORAL_ACTIVATOR__!;
        if (info.unsafe.isReplayingHistoryEvents) return;
        console[level](`[${info.workflowType}(${info.workflowId})]`, ...args);
      }
    };
  }
  const consoleObject = Object.fromEntries(consoleMethods.map((level) => [level, makeConsoleFn(level)]));
  Object.defineProperty(sandboxGlobalThis, 'console', {
    value: consoleObject,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  class AsyncLocalStorage extends AsyncLocalStorageOriginal<any> {
    constructor(private name: string = 'anonymous') {
      super();

      const activator = sandboxGlobalThis.__TEMPORAL_ACTIVATOR__;
      if (activator) {
        activator.workflowSandboxDestructors.push(this.disable.bind(this));
      } else {
        if (sandboxGlobalThis.__temporal_globalSandboxDestructors === undefined)
          Object.defineProperty(sandboxGlobalThis, '__temporal_globalSandboxDestructors', {
            value: [],
            writable: false,
            enumerable: false,
            configurable: false,
          });
        sandboxGlobalThis.__temporal_globalSandboxDestructors!.push(this.disable.bind(this));
      }
    }

    disable(): void {
      super.disable();
    }
  }
  Object.defineProperty(sandboxGlobalThis, 'AsyncLocalStorage', {
    value: AsyncLocalStorage,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  vm.runInContext(
    `if (typeof Symbol.dispose !== 'symbol') Object.defineProperty(Symbol, 'dispose', { value: Symbol.for('nodejs.dispose'), writable: false, enumerable: false, configurable: false });
     if (typeof Symbol.asyncDispose !== 'symbol') Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol.for('nodejs.asyncDispose'), writable: false, enumerable: false, configurable: false });`,
    context
  );
}

/**
 * Global handlers for overriding stack trace preparation and promise hooks
 */
export class GlobalHandlers {
  currentStackTrace: StackTraceFileLocation[] | undefined = undefined;
  bundleFilenameToSourceMapConsumer = new Map<string, SourceMapConsumer>();
  origPrepareStackTrace = Error.prepareStackTrace;
  private stopPromiseHook = () => {};
  private installedPrepareStackTrace: typeof Error.prepareStackTrace = undefined;
  /** How many install() calls have not been matched by a release() yet. */
  private users = 0;
  promiseHookInstalled = false;
  installed = false;

  async addWorkflowBundle(workflowBundle: WorkflowBundleWithSourceMapAndFilename): Promise<void> {
    const sourceMapConsumer = await new SourceMapConsumer(workflowBundle.sourceMap);
    this.bundleFilenameToSourceMapConsumer.set(workflowBundle.filename, sourceMapConsumer);
  }

  removeWorkflowBundle(workflowBundle: WorkflowBundleWithSourceMapAndFilename): void {
    this.bundleFilenameToSourceMapConsumer.delete(workflowBundle.filename);
  }

  /**
   * Set the global hooks if they aren't set yet, and register one more user of them.
   *
   * Each call must be matched by one call to {@link release} once that user is done with the hooks.
   */
  install(): void {
    this.users++;
    if (!this.installed) {
      this.overridePrepareStackTrace();
      this.setPromiseHook();
      this.installed = true;
    }
  }

  /**
   * Unregister one user of the global hooks, and unset the hooks when no user remains.
   *
   * The hooks are global to the isolate. In a workflow worker thread that hardly matters, because the thread ends with
   * the Worker. In debug mode, which includes `Worker.runReplayHistory`, the hooks run on the main thread, so leaving
   * them in place would make them run on every promise the host application creates afterwards.
   */
  release(): void {
    if (this.users === 0) return;
    this.users--;
    if (this.users === 0) this.uninstall();
  }

  /**
   * Unset all installed global hooks, whatever the number of users.
   */
  uninstall(): void {
    this.stopPromiseHook();
    this.stopPromiseHook = () => {};
    this.promiseHookInstalled = false;
    // Don't clobber a prepareStackTrace that someone else set after ours.
    if (Error.prepareStackTrace === this.installedPrepareStackTrace) {
      Error.prepareStackTrace = this.origPrepareStackTrace;
    }
    this.installedPrepareStackTrace = undefined;
    this.users = 0;
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
    this.installedPrepareStackTrace = Error.prepareStackTrace = (err, stackTraces) => {
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
    try {
      this.stopPromiseHook = v8.promiseHooks.createHook({
        init: (promise: Promise<unknown>, parent: Promise<unknown>) => {
          // Only run in workflow context
          const activator = getActivator(promise);
          if (!activator) return;
          const store = activator.promiseStackStore;
          // TODO: hide this somehow: defineProperty + symbol
          (promise as any).runId = activator.info.runId;
          // Reset currentStackTrace just in case (it will be set in `prepareStackTrace` above)
          this.currentStackTrace = undefined;
          // getActivator() returned an activator, so this realm lookup succeeded a moment ago.
          const fn = getPromiseRealmFunction(promise)!;
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
            /^\s+at\sPromise\.then \(<anonymous>\)\n\s+at (Function|Promise)\.(race|all|allSettled|any) \(<anonymous>\)\n/.test(
              formatted
            )
          ) {
            // Skip internal promises created by the aggregator and link directly.
            promise = currentAggregation;

            stackTrace = store.promiseToStack.get(currentAggregation)!; // Must exist
          } else if (/^\s+at (Function|Promise)\.(race|all|allSettled|any) \(<anonymous>\)\n/.test(formatted)) {
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
      }) as () => void;
      this.promiseHookInstalled = true;
    } catch (_) {
      // v8.promiseHooks.createHook is not available in bun and Node.js < 16.14.0.
      // That's ok, collecting stack trace is an optional feature anyway.
      //
      // FIXME: This should be sent to logs, not the console… but we don't have access to it here.
      console.warn('v8.promiseHooks.createHook is not available; stack trace collection will be disabled.');
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
   *
   * In Bun versions before 1.4.0, `microtaskMode: afterEvaluate` is not supported. On those versions, immediately
   * schedule a task after each call into the `workflowModule` so that microtasks from a specific workflow execute
   * while the VM is still set up for that workflow.
   */
  public async activate(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
    try {
      if (this.context === undefined) throw new IllegalStateError('Workflow isolate context uninitialized');
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
        targetWorkerDeploymentVersionChanged: activation.targetWorkerDeploymentVersionChanged ?? false,
        suggestedContinueAsNewReasons: suggestContinueAsNewReasonsFromProto(activation.suggestContinueAsNewReasons),
        currentBuildId: activation.deploymentVersionForCurrentTask?.buildId ?? '',
        currentDeploymentVersion: convertDeploymentVersion(activation.deploymentVersionForCurrentTask),
        unsafe: {
          ...info.unsafe,
          isReplaying: activation.isReplaying ?? false,
          isReplayingHistoryEvents: activation.isReplaying ?? false,
        },
      }));
      this.activator.addKnownFlags(activation.availableInternalFlags ?? []);
      if (activation.lastSdkVersion) this.activator.sdkVersion = activation.lastSdkVersion;

      // Initialization of the workflow must happen before anything else. Yet, keep the init job in
      // place in the list as we'll use it as a marker to know when to start the workflow function.
      const initWorkflowJob = activation.jobs.find((job) => job.initializeWorkflow != null)?.initializeWorkflow;
      if (initWorkflowJob) {
        this.workflowModule.initialize(initWorkflowJob);
        if (isBunPre1_4) await new Promise(setImmediate);
      }

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
          this.activator.updateRandomSeed(updateRandomSeed[updateRandomSeed.length - 1]!.updateRandomSeed!);
        this.workflowModule.activate(
          coresdk.workflow_activation.WorkflowActivation.fromObject({ ...activation, jobs: rest })
        );
        if (isBunPre1_4) {
          await this.tryUnblockConditionsAndMicrotasksWithManualFlush();
        } else {
          this.tryUnblockConditionsAndMicrotasks();
        }
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
          if (isBunPre1_4) {
            await this.tryUnblockConditionsAndMicrotasksWithManualFlush();
          } else {
            this.tryUnblockConditionsAndMicrotasks();
          }
        }
      }

      if (isBunPre1_4) await new Promise(setImmediate);
      const completion = this.workflowModule.concludeActivation();

      // Give unhandledRejection handler a chance to be triggered.
      await new Promise(setImmediate);
      if (this.unhandledRejection) throw this.unhandledRejection;

      return completion;
    } catch (err) {
      return {
        runId: this.activator.info.runId,
        // FIXME: Calling `activator.errorToFailure()` directly from outside the VM is unsafe, as it
        // depends on the `failureConverter` and `payloadConverter`, which may be customized and
        // therefore aren't guaranteed not to access `global` or to cause scheduling microtasks.
        // Admitingly, the risk is very low, so we're leaving it as is for now.
        failed: { failure: this.activator.errorToFailure(err) },
      };
    }
  }

  private async activateQueries(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
    this.activator.mutateWorkflowInfo((info) => ({
      ...info,
      unsafe: {
        ...info.unsafe,
        isReplaying: true,
        // Queries are live read-only operations, not replay of history events
        isReplayingHistoryEvents: false,
      },
    }));
    this.workflowModule.activate(activation);
    if (isBunPre1_4) await new Promise(setImmediate);
    const completion = this.workflowModule.concludeActivation();
    if (isBunPre1_4) await new Promise(setImmediate);
    return completion;
  }

  /**
   * If called (by an external unhandledRejection handler), activations will fail with provided error.
   */
  public setUnhandledRejection(err: unknown): void {
    if (this.activator) {
      // This is very unlikely to make a difference, as unhandled rejections should be reported
      // on the next macro task of the outer execution context (i.e. not inside the VM), at which
      // point we are done handling the workflow activation anyway. But just in case, copying the
      // error to the activator will ensure that any attempt to make progress in the workflow
      // VM will immediately fail.
      this.activator.workflowTaskError = err;
    }
    this.unhandledRejection = err;
  }

  /**
   * Call into the Workflow context to attempt to unblock any blocked conditions and microtasks.
   *
   * This is performed in a loop, going in and out of the VM, allowing microtasks to be processed
   * between each iteration of the outer loop, until there are no more conditions to unblock.
   */
  protected tryUnblockConditionsAndMicrotasks(): void {
    for (;;) {
      const numUnblocked = this.workflowModule.tryUnblockConditions();
      if (numUnblocked === 0) break;
    }
  }

  /**
   * Same as `tryUnblockConditionsAndMicrotasks`, but not relying on `microtaskMode: afterEvaluate`.
   *
   * Instead of relying on microtasks being flushed by `microtaskMode`, await a `Promise` to give a chance for
   * the microtasks to settle.
   */
  protected async tryUnblockConditionsAndMicrotasksWithManualFlush(): Promise<void> {
    for (;;) {
      await new Promise(setImmediate);
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
