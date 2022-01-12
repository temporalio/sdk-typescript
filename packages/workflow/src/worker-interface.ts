/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import {
  IllegalStateError,
  msToTs,
  tsToMs,
  composeInterceptors,
  Workflow,
  ApplicationFailure,
  errorMessage,
} from '@temporalio/common';
import type { coresdk } from '@temporalio/proto/lib/coresdk';
import { WorkflowInfo } from './interfaces';
import { handleWorkflowFailure, InterceptorsImportFunc, state, WorkflowsImportFunc } from './internals';
import { storage } from './cancellation-scope';
import { alea } from './alea';
import { DeterminismViolationError } from './errors';
import { SinkCall } from './sinks';
import { WorkflowInterceptorsFactory } from './interceptors';

export interface WorkflowCreateOptions {
  info: WorkflowInfo;
  randomnessSeed: number[];
  now: number;
  patches: string[];
}

export interface ImportFunctions {
  importWorkflows: WorkflowsImportFunc;
  importInterceptors: InterceptorsImportFunc;
}
export function setImportFuncs({ importWorkflows, importInterceptors }: ImportFunctions): void {
  state.importWorkflows = importWorkflows;
  state.importInterceptors = importInterceptors;
}

export function overrideGlobals(): void {
  const global = globalThis as any;
  // Mock any weak reference because GC is non-deterministic and the effect is observable from the Workflow.
  // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0.
  // Workflow developer will get a meaningful exception if they try to use these.
  global.WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.FinalizationRegistry = function () {
    throw new DeterminismViolationError(
      'FinalizationRegistry cannot be used in workflows because v8 GC is non-deterministic'
    );
  };

  const OriginalDate = globalThis.Date;

  global.Date = function (...args: unknown[]) {
    if (args.length > 0) {
      return new (OriginalDate as any)(...args);
    }
    return new OriginalDate(state.now);
  };

  global.Date.now = function () {
    return state.now;
  };

  global.Date.parse = OriginalDate.parse.bind(OriginalDate);
  global.Date.UTC = OriginalDate.UTC.bind(OriginalDate);

  global.Date.prototype = OriginalDate.prototype;

  /**
   * @param ms sleep duration -  number of milliseconds. If given a negative number, value will be set to 1.
   */
  global.setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
    ms = Math.max(1, ms);
    const seq = state.nextSeqs.timer++;
    // Create a Promise for AsyncLocalStorage to be able to track this completion using promise hooks.
    new Promise((resolve, reject) => {
      state.completions.timer.set(seq, { resolve, reject });
      state.pushCommand({
        startTimer: {
          seq,
          startToFireTimeout: msToTs(ms),
        },
      });
    }).then(
      () => cb(...args),
      () => undefined /* ignore cancellation */
    );
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

/**
 * Initialize the isolate runtime.
 *
 * Sets required internal state and instantiates the workflow and interceptors.
 */
export async function initRuntime({ info, randomnessSeed, now, patches }: WorkflowCreateOptions): Promise<void> {
  // Set the runId globally on the context so it can be retrieved in the case
  // of an unhandled promise rejection.
  (globalThis as any).__TEMPORAL__.runId = info.runId;

  // Globals are overridden while building the isolate before loading user code.
  // For some reason the `WeakRef` mock is not restored properly when creating an isolate from snapshot in node 14 (at least on ubuntu), override again.
  (globalThis as any).WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };
  state.info = info;
  state.now = now;
  state.random = alea(randomnessSeed);
  if (info.isReplaying) {
    for (const patch of patches) {
      state.knownPresentPatches.add(patch);
    }
  }

  const { importWorkflows, importInterceptors } = state;
  if (importWorkflows === undefined || importInterceptors === undefined) {
    throw new IllegalStateError('Workflow has not been initialized');
  }

  const interceptors = await importInterceptors();
  for (const mod of interceptors) {
    const factory: WorkflowInterceptorsFactory = mod.interceptors;
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

  let workflow: Workflow;
  try {
    const mod = await importWorkflows();
    workflow = mod[info.workflowType];
    if (typeof workflow !== 'function') {
      throw new TypeError(`'${info.workflowType}' is not a function`);
    }
  } catch (err) {
    const failure = ApplicationFailure.nonRetryable(errorMessage(err), 'ReferenceError');
    failure.stack = failure.stack?.split('\n')[0];
    handleWorkflowFailure(failure);
    return;
  }
  state.workflow = workflow;
}

export interface ActivationResult {
  numBlockedConditions: number;
}

/**
 * Run a chunk of activation jobs
 * @returns a boolean indicating whether job was processed or ignored
 */
export async function activate(
  activation: coresdk.workflow_activation.WorkflowActivation,
  batchIndex: number
): Promise<ActivationResult> {
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
        if (activation.timestamp != null) {
          // timestamp will not be updated for activation that contain only queries
          state.now = tsToMs(activation.timestamp);
        }
        state.info.isReplaying = activation.isReplaying ?? false;
      }

      // Cast from the interface to the class which has the `variant` attribute.
      // This is safe because we know that activation is a proto class.
      const jobs = activation.jobs as coresdk.workflow_activation.WorkflowActivationJob[];

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
          await state.activator[job.variant](variant as any /* TS can't infer this type */);
          tryUnblockConditions();
        })
      );
    }
  );
  await intercept({
    activation,
    batchIndex,
  });

  return {
    numBlockedConditions: state.blockedConditions.size,
  };
}

/**
 * Conclude a single activation.
 * Should be called after processing all activation jobs and queued microtasks.
 *
 * Activation failures are handled in the main Node.js isolate.
 */
export function concludeActivation(): coresdk.workflow_completion.IWorkflowActivationCompletion {
  const intercept = composeInterceptors(state.interceptors.internals, 'concludeActivation', (input) => input);
  const { info } = state;
  const { commands } = intercept({ commands: state.commands });
  state.commands = [];
  return {
    runId: info?.runId,
    successful: { commands },
  };
}

export function getAndResetSinkCalls(): SinkCall[] {
  return state.getAndResetSinkCalls();
}

/**
 * Loop through all blocked conditions, evaluate and unblock if possible.
 *
 * @returns number of unblocked conditions.
 */
export function tryUnblockConditions(): number {
  let numUnblocked = 0;
  for (;;) {
    const prevUnblocked = numUnblocked;
    for (const [seq, cond] of state.blockedConditions.entries()) {
      if (cond.fn()) {
        cond.resolve();
        numUnblocked++;
        // It is safe to delete elements during map iteration
        state.blockedConditions.delete(seq);
      }
    }
    if (prevUnblocked === numUnblocked) {
      break;
    }
  }
  return numUnblocked;
}

export async function dispose(): Promise<void> {
  const dispose = composeInterceptors(state.interceptors.internals, 'dispose', async () => {
    storage.disable();
  });
  await dispose({});
}
