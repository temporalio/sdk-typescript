/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import { IllegalStateError } from '@temporalio/common';
import { msToTs, tsToMs } from '@temporalio/common/lib/time';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import type { coresdk } from '@temporalio/proto';
import { storage } from './cancellation-scope';
import { DeterminismViolationError } from './errors';
import { WorkflowInterceptorsFactory } from './interceptors';
import { WorkflowCreateOptionsWithSourceMap } from './interfaces';
import { Activator, getActivator } from './internals';
import { SinkCall } from './sinks';

// Export the type for use on the "worker" side
export { PromiseStackStore } from './internals';

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
    return new OriginalDate(getActivator().now);
  };

  global.Date.now = function () {
    return getActivator().now;
  };

  global.Date.parse = OriginalDate.parse.bind(OriginalDate);
  global.Date.UTC = OriginalDate.UTC.bind(OriginalDate);

  global.Date.prototype = OriginalDate.prototype;

  /**
   * @param ms sleep duration -  number of milliseconds. If given a negative number, value will be set to 1.
   */
  global.setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
    const activator = getActivator();
    ms = Math.max(1, ms);
    const seq = activator.nextSeqs.timer++;
    // Create a Promise for AsyncLocalStorage to be able to track this completion using promise hooks.
    new Promise((resolve, reject) => {
      activator.completions.timer.set(seq, { resolve, reject });
      activator.pushCommand({
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
    const activator = getActivator();
    activator.nextSeqs.timer++;
    activator.completions.timer.delete(handle);
    activator.pushCommand({
      cancelTimer: {
        seq: handle,
      },
    });
  };

  // activator.random is mutable, don't hardcode its reference
  Math.random = () => getActivator().random();
}

/**
 * Initialize the isolate runtime.
 *
 * Sets required internal state and instantiates the workflow and interceptors.
 */
export async function initRuntime(options: WorkflowCreateOptionsWithSourceMap): Promise<void> {
  const { info } = options;
  info.unsafe.now = OriginalDate.now;
  const activator = new Activator(options);
  // There's on activator per workflow instance, set it globally on the context.
  // We do this before importing any user code so user code can statically reference @temporalio/workflow functions
  // as well as Date and Math.random.
  global.__TEMPORAL__.activator = activator;

  // TODO(bergundy): check if we can use `require` with the ESM sample and make all of the runtime methods sync.

  // @ts-expect-error this is a webpack alias to payloadConverterPath
  const customPayloadConverter = (await import('__temporal_custom_payload_converter')).payloadConverter;
  // The `payloadConverter` export is validated in the Worker
  if (customPayloadConverter !== undefined) {
    activator.payloadConverter = customPayloadConverter;
  }
  // @ts-expect-error this is a webpack alias to failureConverterPath
  const customFailureConverter = (await import('__temporal_custom_failure_converter')).failureConverter;
  // The `failureConverter` export is validated in the Worker
  if (customFailureConverter !== undefined) {
    activator.failureConverter = customFailureConverter;
  }

  const { importWorkflows, importInterceptors } = global.__TEMPORAL__;
  if (importWorkflows === undefined || importInterceptors === undefined) {
    throw new IllegalStateError('Workflow bundle did not register import hooks');
  }

  const interceptors = await importInterceptors();
  for (const mod of interceptors) {
    const factory: WorkflowInterceptorsFactory = mod.interceptors;
    if (factory !== undefined) {
      if (typeof factory !== 'function') {
        throw new TypeError(`interceptors must be a function, got: ${factory}`);
      }
      const interceptors = factory();
      activator.interceptors.inbound.push(...(interceptors.inbound ?? []));
      activator.interceptors.outbound.push(...(interceptors.outbound ?? []));
      activator.interceptors.internals.push(...(interceptors.internals ?? []));
    }
  }

  const mod = await importWorkflows();
  const workflow = mod[info.workflowType];
  if (typeof workflow !== 'function') {
    throw new TypeError(`'${info.workflowType}' is not a function`);
  }
  activator.workflow = workflow;
}

/**
 * Run a chunk of activation jobs
 * @returns a boolean indicating whether job was processed or ignored
 */
export function activate(activation: coresdk.workflow_activation.WorkflowActivation, batchIndex: number): void {
  const activator = getActivator();
  const intercept = composeInterceptors(activator.interceptors.internals, 'activate', ({ activation, batchIndex }) => {
    if (batchIndex === 0) {
      if (!activation.jobs) {
        throw new TypeError('Got activation with no jobs');
      }
      if (activation.timestamp != null) {
        // timestamp will not be updated for activation that contain only queries
        activator.now = tsToMs(activation.timestamp);
      }
      if (activation.historyLength == null) {
        throw new TypeError('Got activation with no historyLength');
      }
      activator.info.unsafe.isReplaying = activation.isReplaying ?? false;
      activator.info.historyLength = activation.historyLength;
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
      if (activator.completed && job.variant !== 'queryWorkflow') {
        return;
      }
      activator[job.variant](variant as any /* TS can't infer this type */);
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
  const activator = getActivator();
  const intercept = composeInterceptors(activator.interceptors.internals, 'concludeActivation', (input) => input);
  const { info } = activator;
  const { commands } = intercept({ commands: activator.getAndResetCommands() });
  return {
    runId: info.runId,
    successful: { commands },
  };
}

export function getAndResetSinkCalls(): SinkCall[] {
  return getActivator().getAndResetSinkCalls();
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
    for (const [seq, cond] of getActivator().blockedConditions.entries()) {
      if (cond.fn()) {
        cond.resolve();
        numUnblocked++;
        // It is safe to delete elements during map iteration
        getActivator().blockedConditions.delete(seq);
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
  const dispose = composeInterceptors(getActivator().interceptors.internals, 'dispose', async () => {
    storage.disable();
  });
  await dispose({});
}
