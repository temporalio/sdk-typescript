/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import { IllegalStateError, ProtoFailure } from '@temporalio/common';
import { msToTs, tsToMs } from '@temporalio/common/lib/time';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import type { coresdk } from '@temporalio/proto';
import { alea } from './alea';
import { storage } from './cancellation-scope';
import { DeterminismViolationError } from './errors';
import { WorkflowInterceptorsFactory } from './interceptors';
import { WorkflowInfo } from './interfaces';
import { InterceptorsImportFunc, state, WorkflowsImportFunc } from './internals';
import { SinkCall } from './sinks';
import type { RawSourceMap } from 'source-map';

// Export the type for use on the "worker" side
export { PromiseStackStore } from './internals';

export interface WorkflowCreateOptions {
  info: WorkflowInfo;
  randomnessSeed: number[];
  now: number;
  patches: string[];
  showStackTraceSources: boolean;
}

export interface WorkflowCreateOptionsWithSourceMap extends WorkflowCreateOptions {
  sourceMap: RawSourceMap;
}

export interface ImportFunctions {
  importWorkflows: WorkflowsImportFunc;
  importInterceptors: InterceptorsImportFunc;
}
export function setImportFuncs({ importWorkflows, importInterceptors }: ImportFunctions): void {
  state.importWorkflows = importWorkflows;
  state.importInterceptors = importInterceptors;
}

const global = globalThis as any;
const OriginalDate = globalThis.Date;

export function overrideGlobals(): void {
  // Mock any weak reference because GC is non-deterministic and the effect is observable from the Workflow.
  // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0.
  // Workflow developer will get a meaningful exception if they try to use these.
  global.WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in Workflows because v8 GC is non-deterministic');
  };
  global.FinalizationRegistry = function () {
    throw new DeterminismViolationError(
      'FinalizationRegistry cannot be used in Workflows because v8 GC is non-deterministic'
    );
  };

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
export async function initRuntime({
  info,
  randomnessSeed,
  now,
  patches,
  sourceMap,
  showStackTraceSources,
}: WorkflowCreateOptionsWithSourceMap): Promise<void> {
  // Set the runId globally on the context so it can be retrieved in the case
  // of an unhandled promise rejection.
  global.__TEMPORAL__.runId = info.runId;
  // Set the promiseStackStore so promises can be tracked
  global.__TEMPORAL__.promiseStackStore = {
    promiseToStack: new Map(),
    childToParent: new Map(),
  };

  state.info = info;
  state.info.unsafe.now = OriginalDate.now;
  state.now = now;
  state.random = alea(randomnessSeed);
  state.showStackTraceSources = showStackTraceSources;
  state.sourceMap = sourceMap;

  if (info.unsafe.isReplaying) {
    for (const patch of patches) {
      state.knownPresentPatches.add(patch);
    }
  }

  // @ts-expect-error this is a webpack alias to payloadConverterPath
  const customPayloadConverter = (await import('__temporal_custom_payload_converter')).payloadConverter;
  // The `payloadConverter` export is validated in the Worker
  if (customPayloadConverter !== undefined) {
    state.payloadConverter = customPayloadConverter;
  }
  // @ts-expect-error this is a webpack alias to failureConverterPath
  const customFailureConverter = (await import('__temporal_custom_failure_converter')).failureConverter;
  // The `failureConverter` export is validated in the Worker
  if (customFailureConverter !== undefined) {
    state.failureConverter = customFailureConverter;
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

  const mod = await importWorkflows();
  const workflow = mod[info.workflowType];
  if (typeof workflow !== 'function') {
    throw new TypeError(`'${info.workflowType}' is not a function`);
  }
  state.workflow = workflow;
}

/**
 * Run a chunk of activation jobs
 * @returns a boolean indicating whether job was processed or ignored
 */
export function activate(activation: coresdk.workflow_activation.WorkflowActivation, batchIndex: number): void {
  const intercept = composeInterceptors(state.interceptors.internals, 'activate', ({ activation, batchIndex }) => {
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
      if (activation.historyLength == null) {
        throw new TypeError('Got activation with no historyLength');
      }
      state.info.unsafe.isReplaying = activation.isReplaying ?? false;
      state.info.historyLength = activation.historyLength;
    }

    // Cast from the interface to the class which has the `variant` attribute.
    // This is safe because we know that activation is a proto class.
    const jobs = activation.jobs as coresdk.workflow_activation.WorkflowActivationJob[];

    for (const job of jobs) {
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
      state.activator[job.variant](variant as any /* TS can't infer this type */);
      if (showUnblockConditions(job)) {
        tryUnblockConditions();
      }
    }
  });
  intercept({
    activation,
    batchIndex,
  });
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

/**
 * Predicate used to prevent triggering conditions for non-query and non-patch jobs.
 */
export function showUnblockConditions(job: coresdk.workflow_activation.IWorkflowActivationJob): boolean {
  return !job.queryWorkflow && !job.notifyHasPatch;
}

export async function dispose(): Promise<void> {
  const dispose = composeInterceptors(state.interceptors.internals, 'dispose', async () => {
    storage.disable();
  });
  await dispose({});
}

export function errorToFailure(err: unknown): ProtoFailure {
  return state.failureConverter.errorToFailure(err);
}
