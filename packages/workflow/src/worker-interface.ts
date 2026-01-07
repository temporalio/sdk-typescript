/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import { encodeVersioningBehavior, IllegalStateError, WorkflowFunctionWithOptions } from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { coresdk } from '@temporalio/proto';
import type { WorkflowInterceptorsFactory } from './interceptors';
import type { WorkflowCreateOptionsInternal } from './interfaces';
import { Activator } from './internals';
import { setActivator, getActivator, maybeGetActivator } from './global-attributes';

// Export the type for use on the "worker" side
export { PromiseStackStore } from './internals';

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
  setActivator(activator);

  activator.rethrowSynchronously = true;
  try {
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

    const { importWorkflows, importInterceptors } = globalThis.__TEMPORAL__;
    if (importWorkflows === undefined || importInterceptors === undefined) {
      throw new IllegalStateError('Workflow bundle did not register import hooks');
    }

    const interceptors = importInterceptors();
    for (const mod of interceptors) {
      const factory: WorkflowInterceptorsFactory = mod.interceptors;
      if (factory !== undefined) {
        if (typeof factory !== 'function') {
          throw new TypeError(
            `Failed to initialize workflows interceptors: expected a function, but got: '${factory}'`
          );
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
      } else {
        activator.workflowDefinitionOptionsGetter = activator.workflow.workflowDefinitionOptions;
      }
    }
  } catch (e) {
    try {
      // Core won't send an eviction job after an early error, so we are responsible for triggering
      // disposal of the workflow execution context. Otherwise, there might be resource leaks.
      dispose();
    } catch (_innerError) {
      // Ignore error disposing of activator, it is more important to rethrow the original error
    }
    throw e;
  } finally {
    activator.rethrowSynchronously = false;
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
  const activator = getActivator();
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
export function activate(activation: coresdk.workflow_activation.IWorkflowActivation, batchIndex = 0): void {
  const activator = getActivator();
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
export function concludeActivation(): coresdk.workflow_completion.IWorkflowActivationCompletion {
  const activator = getActivator();
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
export function tryUnblockConditions(): number {
  const activator = getActivator();
  activator.rethrowSynchronously = true;
  try {
    let numUnblocked = 0;
    for (;;) {
      activator.maybeRethrowWorkflowTaskError();
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
export function dispose(): void {
  let error: unknown | undefined = undefined;

  const activator = getActivator();
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
    setActivator(undefined);
  }
}

// Destroy the sandbox VM (not to be confused with disposing of the workflow execution context).
export function destroy(): void {
  const activator = maybeGetActivator();
  if (activator) throw new IllegalStateError('Workflow execution context should have been disposed first');

  let error: unknown | undefined = undefined;
  for (const destructor of globalThis.__temporal_globalSandboxDestructors?.splice(0) ?? []) {
    try {
      destructor();
    } catch (e) {
      if (error == null) {
        error = e;
      }
    }
  }
}

function isWorkflowFunctionWithOptions(obj: any): obj is WorkflowFunctionWithOptions<any[], any> {
  if (obj == null) return false;
  return Object.hasOwn(obj, 'workflowDefinitionOptions');
}
