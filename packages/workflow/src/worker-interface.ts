/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import ivm from 'isolated-vm';
import { ActivityOptions, IllegalStateError, msToTs, tsToMs } from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import { ApplyMode, ExternalDependencyFunction, WorkflowInfo } from './interfaces';
import { consumeCompletion, ExternalCall, state } from './internals';
import { alea } from './alea';
import { IsolateExtension, HookManager } from './promise-hooks';
import { DeterminismViolationError } from './errors';

export { ExternalCall };

export function setRequireFunc(fn: Exclude<typeof state['require'], undefined>): void {
  state.require = fn;
}

export function overrideGlobals(): void {
  const global = globalThis as any;
  // Mock any weak reference holding structures because GC is non-deterministic.
  // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0.
  // Workflow developer will get a meaningful exception if they try to use these.
  global.WeakMap = function () {
    throw new DeterminismViolationError('WeakMap cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.WeakSet = function () {
    throw new DeterminismViolationError('WeakSet cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };

  const OriginalDate = globalThis.Date;

  global.Date = function () {
    return new OriginalDate(state.now);
  };

  global.Date.now = function () {
    return state.now;
  };

  global.Date.prototype = OriginalDate.prototype;

  global.setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
    const seq = state.nextSeq++;
    state.completions.set(`${seq}`, {
      resolve: () => cb(...args),
      reject: () => undefined /* ignore cancellation */,
    });
    state.commands.push({
      startTimer: {
        timerId: `${seq}`,
        startToFireTimeout: msToTs(ms),
      },
    });
    return seq;
  };

  global.clearTimeout = function (handle: number): void {
    state.nextSeq++;
    state.completions.delete(`${handle}`);
    state.commands.push({
      cancelTimer: {
        timerId: `${handle}`,
      },
    });
  };

  // state.random is mutable, don't hardcode its reference
  Math.random = () => state.random();
}

/** Mock DOM element for Webpack dynamic imports */
export interface MockElement {
  getAttribute(name: string): unknown;
  setAttribute(name: string, value: unknown): void;
}

/** Mock document object for Webpack dynamic imports */
export interface MockDocument {
  head: {
    // Ignored
    appendChild(): void;
  };
  getElementsByTagName(): MockElement[];
  createElement(): MockElement;
}

/**
 * Create a mock document object with mimimal required attributes to support Webpack dynamic imports
 */
export function mockBrowserDocumentForWebpack(): MockDocument {
  const attrs = new Map<string, unknown>();
  const el = {
    getAttribute: (name: string) => attrs.get(name),
    setAttribute: (name: string, value: unknown) => {
      attrs.set(name, value);
    },
  };
  return {
    head: {
      appendChild: () => undefined,
    },
    getElementsByTagName: () => {
      return [el];
    },
    createElement: () => {
      return el;
    },
  };
}

export function initRuntime(
  info: WorkflowInfo,
  activityDefaults: ActivityOptions,
  interceptorModules: string[],
  randomnessSeed: number[],
  isolateExtension: IsolateExtension
): void {
  // Globals are overridden while building the isolate before loading user code.
  // For some reason the `WeakRef` mock is not restored properly when creating an isolate from snapshot in node 14 (at least on ubuntu), override again.
  (globalThis as any).WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };
  state.interceptorModules = interceptorModules;
  state.info = info;
  state.activityDefaults = activityDefaults;
  state.random = alea(randomnessSeed);
  HookManager.instance.setIsolateExtension(isolateExtension);
}

type ActivationJobResult = { pendingExternalCalls: ExternalCall[]; processed: boolean };

/**
 * Run a single activation job.
 * @param jobIndex index of job to process in the activation's job array.
 * @returns a boolean indicating whether the job was processed or ignored
 */
export async function activate(encodedActivation: Uint8Array, jobIndex: number): Promise<ActivationJobResult> {
  const activation = coresdk.workflow_activation.WFActivation.decodeDelimited(encodedActivation);
  // job's type is IWFActivationJob which doesn't have the `attributes` property.
  const job = activation.jobs[jobIndex] as coresdk.workflow_activation.WFActivationJob;
  // We only accept time not progressing when processing a query
  if (!(job.variant === 'queryWorkflow' && activation.timestamp === null)) {
    state.now = tsToMs(activation.timestamp);
  }
  if (state.info === undefined) {
    throw new IllegalStateError('Workflow has not been initialized');
  }
  state.info.isReplaying = activation.isReplaying ?? false;
  if (job.variant === undefined) {
    throw new TypeError('Expected job.variant to be defined');
  }
  const variant = job[job.variant];
  if (!variant) {
    throw new TypeError(`Expected job.${job.variant} to be set`);
  }
  // The only job that can be executed on a completed workflow is a query.
  // We might get other jobs after completion for instance when a single
  // activation contains multiple jobs and the first one completes the workflow.
  if (state.completed && job.variant !== 'queryWorkflow') {
    return { processed: false, pendingExternalCalls: state.getAndResetPendingExternalCalls() };
  }
  await state.activator[job.variant](variant as any /* TODO: TS is struggling with `true` and `{}` */);
  return { processed: true, pendingExternalCalls: state.getAndResetPendingExternalCalls() };
}

type ActivationConclusion =
  | { type: 'pending'; pendingExternalCalls: ExternalCall[] }
  | { type: 'complete'; encoded: Uint8Array };

/**
 * Conclude a single activation.
 * Should be called after processing all activation jobs and queued microtasks.
 *
 * Activation may be in either `complete` or `pending` state according to pending external dependency calls.
 * Activation failures are handled in the main Node.js isolate.
 */
export function concludeActivation(): ActivationConclusion {
  const pendingExternalCalls = state.getAndResetPendingExternalCalls();
  if (pendingExternalCalls.length > 0) {
    return { type: 'pending', pendingExternalCalls };
  }
  const { commands, info } = state;
  const encoded = coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
    runId: info?.runId,
    successful: { commands },
  }).finish();
  state.commands = [];
  return { type: 'complete', encoded };
}

export function getAndResetPendingExternalCalls(): ExternalCall[] {
  return state.getAndResetPendingExternalCalls();
}

/**
 * Inject an external dependency function into the Workflow via global state.
 * The injected function is available via {@link Context.dependencies}.
 */
export function inject(
  ifaceName: string,
  fnName: string,
  dependency: ivm.Reference<ExternalDependencyFunction>,
  applyMode: ApplyMode,
  transferOptions: ivm.TransferOptionsBidirectional
): void {
  if (state.dependencies[ifaceName] === undefined) {
    state.dependencies[ifaceName] = {};
  }
  if (applyMode === ApplyMode.ASYNC) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      new Promise((resolve, reject) => {
        const seq = state.nextSeq++;
        state.completions.set(`${seq}`, {
          resolve,
          reject,
        });
        state.pendingExternalCalls.push({ ifaceName, fnName, args, seq: `${seq}` });
      });
  } else if (applyMode === ApplyMode.ASYNC_IGNORED) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      state.pendingExternalCalls.push({ ifaceName, fnName, args });
  } else {
    state.dependencies[ifaceName][fnName] = (...args: any[]) => dependency[applyMode](undefined, args, transferOptions);
  }
}

export interface ExternalDependencyResult {
  seq: string;
  result: any;
  error: any;
}

/**
 * Resolve external dependency function calls with given results.
 */
export function resolveExternalDependencies(results: ExternalDependencyResult[]): void {
  for (const { seq, result, error } of results) {
    const completion = consumeCompletion(seq);
    if (error) {
      completion.reject(error);
    } else {
      completion.resolve(result);
    }
  }
}
