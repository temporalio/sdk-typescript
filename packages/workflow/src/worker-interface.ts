/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import ivm from 'isolated-vm';
import { IllegalStateError, msToTs, tsToMs, composeInterceptors } from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import { WorkflowInfo, ActivationJobResult } from './interfaces';
import { consumeCompletion, state } from './internals';
import { alea } from './alea';
import { IsolateExtension, HookManager } from './promise-hooks';
import { DeterminismViolationError } from './errors';
import { ApplyMode, ExternalDependencyFunction, ExternalCall } from './dependencies';
import { WorkflowInterceptorsFactory } from './interceptors';

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
    const seq = state.nextSeqs.timer++;
    state.completions.timer.set(seq, {
      resolve: () => cb(...args),
      reject: () => undefined /* ignore cancellation */,
    });
    state.commands.push({
      startTimer: {
        seq,
        startToFireTimeout: msToTs(ms),
      },
    });
    return seq;
  };

  global.clearTimeout = function (handle: number): void {
    state.nextSeqs.timer++;
    state.completions.timer.delete(handle);
    state.commands.push({
      cancelTimer: {
        seq: handle,
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
  interceptorModules: string[],
  randomnessSeed: number[],
  isolateExtension: IsolateExtension
): void {
  // Globals are overridden while building the isolate before loading user code.
  // For some reason the `WeakRef` mock is not restored properly when creating an isolate from snapshot in node 14 (at least on ubuntu), override again.
  (globalThis as any).WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };
  state.info = info;
  state.random = alea(randomnessSeed);
  HookManager.instance.setIsolateExtension(isolateExtension);

  const { require: req } = state;
  if (req === undefined) {
    throw new IllegalStateError('Workflow has not been initialized');
  }

  for (const mod of interceptorModules) {
    const factory: WorkflowInterceptorsFactory = req(mod, 'interceptors');
    if (factory !== undefined) {
      if (typeof factory !== 'function') {
        throw new TypeError(`interceptors must be a function, got: ${factory}`);
      }
      const interceptors = factory();
      state.interceptors.inbound.push(...(interceptors.inbound ?? []));
      state.interceptors.outbound.push(...(interceptors.outbound ?? []));
      state.interceptors.internals.push(...(interceptors.internals ?? []));
    }
  }
}

/**
 * Run a single activation job.
 * @param jobIndex index of job to process in the activation's job array.
 * @returns a boolean indicating whether the job was processed or ignored
 */
export async function activate(encodedActivation: Uint8Array, jobIndex: number): Promise<ActivationJobResult> {
  const intercept = composeInterceptors(state.interceptors.internals, 'activate', async ({ activation, jobIndex }) => {
    const job = activation.jobs?.[jobIndex] as coresdk.workflow_activation.WFActivationJob;
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
      return false;
    }
    await state.activator[job.variant](variant as any /* TODO: TS is struggling with `true` and `{}` */);
    return true;
  });

  return {
    processed: await intercept({
      activation: coresdk.workflow_activation.WFActivation.decodeDelimited(encodedActivation),
      jobIndex,
    }),
    pendingExternalCalls: state.getAndResetPendingExternalCalls(),
  };
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
  const intercept = composeInterceptors(state.interceptors.internals, 'concludeActivation', (input) => input);
  const { info } = state;
  const { commands } = intercept({ commands: state.commands });
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
 * The injected function is available via {@link dependencies}.
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
        const seq = state.nextSeqs.dependency++;
        state.completions.dependency.set(seq, {
          resolve,
          reject,
        });
        state.pendingExternalCalls.push({ ifaceName, fnName, args, seq });
      });
  } else if (applyMode === ApplyMode.ASYNC_IGNORED) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      state.pendingExternalCalls.push({ ifaceName, fnName, args });
  } else {
    state.dependencies[ifaceName][fnName] = (...args: any[]) => dependency[applyMode](undefined, args, transferOptions);
  }
}

export interface ExternalDependencyResult {
  seq: number;
  result: any;
  error: any;
}

/**
 * Resolve external dependency function calls with given results.
 */
export function resolveExternalDependencies(results: ExternalDependencyResult[]): void {
  for (const { seq, result, error } of results) {
    const completion = consumeCompletion('dependency', seq);
    if (error) {
      completion.reject(error);
    } else {
      completion.resolve(result);
    }
  }
}
