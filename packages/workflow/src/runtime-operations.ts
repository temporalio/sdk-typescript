/**
 * Synchronous workflow operations shared by execution environments.
 *
 * @module
 */
import {
  encodeVersioningBehavior,
  isWorkflowFunctionWithOptions,
  isWorkflowFunctionWithStaticOptions,
} from '@temporalio/common';
import type { coresdk } from '@temporalio/proto';
import type { WorkflowInterceptorsFactory } from './interceptors';
import type { Activator } from './internals';
import { composeInterceptors } from './interceptor-composition';

/**
 * Import interceptors and select the workflow function after runtime setup.
 */
export function initializeModules(
  activator: Activator,
  importWorkflows: typeof globalThis.__TEMPORAL__.importWorkflows,
  importInterceptors: typeof globalThis.__TEMPORAL__.importInterceptors
): void {
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
  if (isWorkflowFunctionWithOptions(activator.workflow)) {
    if (typeof activator.workflow.workflowDefinitionOptions === 'object') {
      activator.versioningBehavior = activator.workflow.workflowDefinitionOptions.versioningBehavior;
      activator.workflowDefinitionFailureExceptionTypes =
        activator.workflow.workflowDefinitionOptions.failureExceptionTypes;
    } else {
      activator.workflowDefinitionOptionsGetter = activator.workflow.workflowDefinitionOptions;
    }
  }
  if (isWorkflowFunctionWithStaticOptions(activator.workflow)) {
    activator.typeInfo = activator.workflow.staticOptions.typeInfo;
  }
}

/**
 * Initialize the workflow. Or to be exact, _complete_ initialization, as most part has been done in constructor).
 */
export function initialize(
  activator: Activator,
  initializeWorkflowJob: coresdk.workflow_activation.IInitializeWorkflow
): void {
  activator.rethrowSynchronously = true;
  try {
    activator.initializeWorkflow(initializeWorkflowJob);
  } finally {
    activator.rethrowSynchronously = false;
  }
}

/**
 * Run a chunk of activation jobs.
 *
 * Notice that this function is not async and runs _inside_ the VM context. Therefore, no microtask
 * will get executed _while_ this function is active; they will however get executed _after_ this
 * function returns (i.e. all outstanding microtasks in the VM will get executed before execution
 * resumes out of the VM, in `vm-shared.ts:activate()`).
 */
export function activate(
  activator: Activator,
  activation: coresdk.workflow_activation.IWorkflowActivation,
  batchIndex = 0
): void {
  activator.rethrowSynchronously = true;
  try {
    const intercept = composeInterceptors(activator.interceptors.internals, 'activate', ({ activation }) => {
      // Cast from the interface to the class which has the `variant` attribute.
      // This is safe because we know that activation is a proto class.
      const jobs = activation.jobs as coresdk.workflow_activation.WorkflowActivationJob[];

      // Initialization will have been handled already, but we might still need to start the workflow function
      const startWorkflowJob = jobs[0]?.variant === 'initializeWorkflow' ? jobs.shift()?.initializeWorkflow : undefined;

      for (const job of jobs) {
        if (job.variant === undefined) throw new TypeError('Expected job.variant to be defined');

        const variant = job[job.variant];
        if (!variant) throw new TypeError(`Expected job.${job.variant} to be set`);

        activator[job.variant](variant as any /* TS can't infer this type */);

        if (job.variant !== 'queryWorkflow') tryUnblockConditions(activator);
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

        tryUnblockConditions(activator);
      }
    });
    intercept({ activation, batchIndex });
  } finally {
    activator.rethrowSynchronously = false;
  }
}

/**
 * Conclude a single activation.
 * Should be called after processing all activation jobs and queued microtasks.
 *
 * Activation failures are handled in the main Node.js isolate.
 */
export function concludeActivation(activator: Activator): coresdk.workflow_completion.IWorkflowActivationCompletion {
  activator.rethrowSynchronously = true;
  try {
    activator.rejectBufferedUpdates();
    const intercept = composeInterceptors(activator.interceptors.internals, 'concludeActivation', (input) => input);
    const activationCompletion = activator.concludeActivation();
    const { commands } = intercept({ commands: activationCompletion.commands });
    if (activator.completed) {
      activator.warnIfUnfinishedHandlers();
    }
    return {
      runId: activator.info.runId,
      successful: {
        ...activationCompletion,
        commands,
        versioningBehavior: encodeVersioningBehavior(activationCompletion.versioningBehavior),
      },
    };
  } finally {
    activator.rethrowSynchronously = false;
  }
}

/**
 * Loop through all blocked conditions, evaluate and unblock if possible.
 *
 * @returns number of unblocked conditions.
 */
export function tryUnblockConditions(activator: Activator): number {
  activator.rethrowSynchronously = true;
  try {
    let numUnblocked = 0;
    for (;;) {
      activator.maybeRethrowWorkflowTaskError();
      // Rejected updates leave nothing in history, so a condition they let through (e.g. one on a value
      // refreshed every activation) could not unblock on replay.
      if (!activator.checkConditions) break;
      const prevUnblocked = numUnblocked;
      for (const [seq, cond] of activator.blockedConditions.entries()) {
        if (cond.fn()) {
          cond.resolve();
          numUnblocked++;
          // It is safe to delete elements during map iteration
          activator.blockedConditions.delete(seq);
        }
      }
      if (prevUnblocked === numUnblocked) {
        break;
      }
    }
    return numUnblocked;
  } finally {
    activator.rethrowSynchronously = false;
  }
}

// Handle disposal of the workflow execution context (not to be confused with destroying
// the sandbox vm, which may possibly be reused if `reuseV8Context` is true).
export function dispose(activator: Activator, clearActivator: () => void): void {
  let error: unknown | undefined = undefined;

  activator.rethrowSynchronously = true;
  try {
    try {
      const dispose = composeInterceptors(activator.interceptors.internals, 'dispose', async () => {});
      dispose({});
    } catch (e) {
      error = e;
    }

    // Destructors are run outside of interceptors, because interceptors themselves often rely
    // on objects that will be destroyed (notably AsyncLocalStorage instances), and because we
    // want to make sure that resources get cleaned up even if an interceptor throws an error.
    // Only the first error (if any) is rethrown.
    for (const destructor of activator.workflowSandboxDestructors.splice(0)) {
      try {
        destructor();
      } catch (e) {
        if (error == null) {
          error = e;
        }
      }
    }

    if (error != null) throw error;
  } finally {
    activator.rethrowSynchronously = false;

    // The activator is no longer valid past this point.
    clearActivator();
  }
}
