/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import { IllegalStateError } from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { coresdk } from '@temporalio/proto';
import { disableStorage } from './cancellation-scope';
import { disableUpdateStorage } from './update-scope';
import { WorkflowInterceptorsFactory } from './interceptors';
import { WorkflowCreateOptionsInternal } from './interfaces';
import { Activator } from './internals';
import { setActivatorUntyped, getActivator } from './global-attributes';

// Export the type for use on the "worker" side
export { PromiseStackStore } from './internals';

const global = globalThis as any;
const OriginalDate = globalThis.Date;

/**
 * Initialize the isolate runtime.
 *
 * Sets required internal state and instantiates the workflow and interceptors.
 */
export function initRuntime(options: WorkflowCreateOptionsInternal): void {
  const activator = new Activator({
    ...options,
    info: fixPrototypes({
      ...options.info,
      unsafe: { ...options.info.unsafe, now: OriginalDate.now },
    }),
  });
  // There's one activator per workflow instance, set it globally on the context.
  // We do this before importing any user code so user code can statically reference @temporalio/workflow functions
  // as well as Date and Math.random.
  setActivatorUntyped(activator);

  // webpack alias to payloadConverterPath
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const customPayloadConverter = require('__temporal_custom_payload_converter').payloadConverter;
  // The `payloadConverter` export is validated in the Worker
  if (customPayloadConverter != null) {
    activator.payloadConverter = customPayloadConverter;
  }
  // webpack alias to failureConverterPath
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const customFailureConverter = require('__temporal_custom_failure_converter').failureConverter;
  // The `failureConverter` export is validated in the Worker
  if (customFailureConverter != null) {
    activator.failureConverter = customFailureConverter;
  }

  const { importWorkflows, importInterceptors } = global.__TEMPORAL__;
  if (importWorkflows === undefined || importInterceptors === undefined) {
    throw new IllegalStateError('Workflow bundle did not register import hooks');
  }

  const interceptors = importInterceptors();
  for (const mod of interceptors) {
    const factory: WorkflowInterceptorsFactory = mod.interceptors;
    if (factory !== undefined) {
      if (typeof factory !== 'function') {
        throw new TypeError(`Failed to initialize workflows interceptors: expected a function, but got: '${factory}'`);
      }
      const interceptors = factory();
      activator.interceptors.inbound.push(...(interceptors.inbound ?? []));
      activator.interceptors.outbound.push(...(interceptors.outbound ?? []));
      activator.interceptors.internals.push(...(interceptors.internals ?? []));
    }
  }

  const mod = importWorkflows();
  const workflowFn = mod[activator.info.workflowType];
  const defaultWorkflowFn = mod['default'];

  if (typeof workflowFn === 'function') {
    activator.workflow = workflowFn;
  } else if (typeof defaultWorkflowFn === 'function') {
    activator.workflow = defaultWorkflowFn;
  } else {
    const details =
      workflowFn === undefined
        ? 'no such function is exported by the workflow bundle'
        : `expected a function, but got: '${typeof workflowFn}'`;
    throw new TypeError(`Failed to initialize workflow of type '${activator.info.workflowType}': ${details}`);
  }
}

/**
 * Objects transfered to the VM from outside have prototypes belonging to the
 * outer context, which means that instanceof won't work inside the VM. This
 * function recursively walks over the content of an object, and recreate some
 * of these objects (notably Array, Date and Objects).
 */
function fixPrototypes<X>(obj: X): X {
  if (obj != null && typeof obj === 'object') {
    switch (Object.getPrototypeOf(obj)?.constructor?.name) {
      case 'Array':
        return Array.from((obj as Array<unknown>).map(fixPrototypes)) as X;
      case 'Date':
        return new Date(obj as unknown as Date) as X;
      default:
        return Object.fromEntries(Object.entries(obj).map(([k, v]): [string, any] => [k, fixPrototypes(v)])) as X;
    }
  } else return obj;
}

/**
 * Initialize the workflow. Or to be exact, _complete_ initialization, as most part has been done in constructor).
 */
export function initialize(initializeWorkflowJob: coresdk.workflow_activation.IInitializeWorkflow): void {
  getActivator().initializeWorkflow(initializeWorkflowJob);
}

/**
 * Run a chunk of activation jobs
 */
export function activate(activation: coresdk.workflow_activation.IWorkflowActivation, batchIndex = 0): void {
  const activator = getActivator();
  const intercept = composeInterceptors(activator.interceptors.internals, 'activate', ({ activation }) => {
    // Cast from the interface to the class which has the `variant` attribute.
    // This is safe because we know that activation is a proto class.
    const jobs = activation.jobs as coresdk.workflow_activation.WorkflowActivationJob[];

    // Initialization will have been handled already, but we might still need to start the workflow function
    const startWorkflowJob = jobs[0].variant === 'initializeWorkflow' ? jobs.shift()?.initializeWorkflow : undefined;

    for (const job of jobs) {
      if (job.variant === undefined) throw new TypeError('Expected job.variant to be defined');

      const variant = job[job.variant];
      if (!variant) throw new TypeError(`Expected job.${job.variant} to be set`);

      activator[job.variant](variant as any /* TS can't infer this type */);

      if (job.variant !== 'queryWorkflow') tryUnblockConditions();
    }

    if (startWorkflowJob) {
      const safeJobTypes: coresdk.workflow_activation.WorkflowActivationJob['variant'][] = [
        'initializeWorkflow',
        'signalWorkflow',
        'doUpdate',
        'cancelWorkflow',
        'updateRandomSeed',
      ];
      if (jobs.some((job) => !safeJobTypes.includes(job.variant))) {
        throw new TypeError(
          'Received both initializeWorkflow and non-signal/non-update jobs in the same activation: ' +
            JSON.stringify(jobs.map((job) => job.variant))
        );
      }

      activator.startWorkflow(startWorkflowJob);
      tryUnblockConditions();
    }
  });
  intercept({ activation, batchIndex });
}

/**
 * Conclude a single activation.
 * Should be called after processing all activation jobs and queued microtasks.
 *
 * Activation failures are handled in the main Node.js isolate.
 */
export function concludeActivation(): coresdk.workflow_completion.IWorkflowActivationCompletion {
  const activator = getActivator();
  activator.rejectBufferedUpdates();
  const intercept = composeInterceptors(activator.interceptors.internals, 'concludeActivation', (input) => input);
  const activationCompletion = activator.concludeActivation();
  const { commands } = intercept({ commands: activationCompletion.commands });
  if (activator.completed) {
    activator.warnIfUnfinishedHandlers();
  }

  return {
    runId: activator.info.runId,
    successful: { ...activationCompletion, commands },
  };
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

export function dispose(): void {
  const dispose = composeInterceptors(getActivator().interceptors.internals, 'dispose', async () => {
    disableStorage();
    disableUpdateStorage();
  });
  dispose({});
}
