/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import ivm from 'isolated-vm';
import {
  IllegalStateError,
  msToTs,
  tsToMs,
  composeInterceptors,
  Workflow,
  ApplicationFailure,
  errorMessage,
  arrayFromPayloadsSync,
} from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import { WorkflowInfo } from './interfaces';
import { consumeCompletion, handleWorkflowFailure, state } from './internals';
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
    state.pushCommand({
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
    state.pushCommand({
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

export async function initRuntime(
  info: WorkflowInfo,
  interceptorModules: string[],
  randomnessSeed: number[],
  isolateExtension: IsolateExtension,
  encodedStartWorkflow: Uint8Array
): Promise<void> {
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
  const { headers, arguments: args } = coresdk.workflow_activation.StartWorkflow.decodeDelimited(encodedStartWorkflow);

  const create = composeInterceptors(state.interceptors.inbound, 'create', async ({ args }) => {
    let mod: Workflow;
    try {
      mod = req(undefined, info.workflowType);
      if (typeof mod !== 'function') {
        throw new TypeError(`'${info.workflowType}' is not a function`);
      }
    } catch (err) {
      const failure = ApplicationFailure.nonRetryable(errorMessage(err), 'ReferenceError');
      failure.stack = failure.stack?.split('\n')[0];
      throw failure;
    }
    return mod(...args);
  });

  state.workflow =
    (await create({
      headers: new Map(Object.entries(headers ?? {})),
      args: arrayFromPayloadsSync(state.dataConverter, args),
    }).catch(handleWorkflowFailure)) ?? undefined;
}

/**
 * Run a chunk of activation jobs
 * @returns a boolean indicating whether job was processed or ignored
 */
export async function activate(encodedActivation: Uint8Array, batchIndex: number): Promise<ExternalCall[]> {
  const intercept = composeInterceptors(
    state.interceptors.internals,
    'activate',
    async ({ activation, batchIndex }) => {
      if (batchIndex === 0) {
        if (state.info === undefined) {
          throw new IllegalStateError('Workflow has not been initialized');
        }
        if (!activation.jobs) {
          throw new TypeError('Got activation with no jobs');
        }
        if (activation.timestamp !== null) {
          // timestamp will not be updated for activation that contain only queries
          state.now = tsToMs(activation.timestamp);
        }
        state.info.isReplaying = activation.isReplaying ?? false;
      }

      // Cast from the interface to the class which has the `variant` attribute.
      // This is safe because we just decoded this activation from a buffer.
      const jobs = activation.jobs as coresdk.workflow_activation.WFActivationJob[];

      await Promise.all(
        jobs.map(async (job) => {
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
            return;
          }
          await state.activator[job.variant](variant as any /* TODO: TS is struggling with `true` and `{}` */);
        })
      );
    }
  );
  await intercept({
    activation: coresdk.workflow_activation.WFActivation.decodeDelimited(encodedActivation),
    batchIndex,
  });

  return state.getAndResetPendingExternalCalls();
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
