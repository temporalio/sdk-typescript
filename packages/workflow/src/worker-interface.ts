/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import { IllegalStateError } from '@temporalio/common';
import type { coresdk } from '@temporalio/proto';
import type { WorkflowCreateOptionsInternal } from './interfaces';
import { Activator } from './internals';
import { setActivator, getActivator, maybeGetActivator } from './global-attributes';
import { createUnsafeRandomSource } from './random-helpers';
import * as operations from './runtime-operations';

// Export the type for use on the "worker" side
export { PromiseStackStore } from './internals';

const OriginalDate = globalThis.Date;
const OriginalMathRandom = globalThis.Math.random;

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
      unsafe: {
        ...options.info.unsafe,
        now: OriginalDate.now,
        random: createUnsafeRandomSource(OriginalMathRandom),
      },
    }),
  });
  // There's one activator per workflow instance, set it globally on the context.
  // We do this before importing any user code so user code can statically reference @temporalio/workflow functions
  // as well as Date and Math.random.
  setActivator(activator);

  activator.rethrowSynchronously = true;
  try {
    // webpack alias to payloadConverterPath
    // oxlint-disable-next-line typescript/no-require-imports
    const customPayloadConverter = require('__temporal_custom_payload_converter').payloadConverter;
    // The `payloadConverter` export is validated in the Worker
    if (customPayloadConverter != null) {
      activator.payloadConverter = customPayloadConverter;
    }
    // webpack alias to failureConverterPath
    // oxlint-disable-next-line typescript/no-require-imports
    const customFailureConverter = require('__temporal_custom_failure_converter').failureConverter;
    // The `failureConverter` export is validated in the Worker
    if (customFailureConverter != null) {
      activator.failureConverter = customFailureConverter;
    }

    const { importWorkflows, importInterceptors } = globalThis.__TEMPORAL__;
    if (importWorkflows === undefined || importInterceptors === undefined) {
      throw new IllegalStateError('Workflow bundle did not register import hooks');
    }

    operations.initializeModules(activator, importWorkflows, importInterceptors);
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

export function initialize(initializeWorkflowJob: coresdk.workflow_activation.IInitializeWorkflow): void {
  operations.initialize(getActivator(), initializeWorkflowJob);
}

export function activate(activation: coresdk.workflow_activation.IWorkflowActivation, batchIndex = 0): void {
  operations.activate(getActivator(), activation, batchIndex);
}

export function concludeActivation(): coresdk.workflow_completion.IWorkflowActivationCompletion {
  return operations.concludeActivation(getActivator());
}

export function tryUnblockConditions(): number {
  return operations.tryUnblockConditions(getActivator());
}

export function dispose(): void {
  operations.dispose(getActivator(), () => setActivator(undefined));
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
