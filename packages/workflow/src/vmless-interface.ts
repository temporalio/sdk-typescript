/**
 * Runtime entry point for bundled VM-less execution. No webpack dependencies.
 */
import type { PayloadConverter, FailureConverter } from '@temporalio/common';
import type { WorkflowCreateOptionsInternal } from './interfaces';
import { Activator } from './internals';
import * as operations from './runtime-operations';
import { createUnsafeRandomSource } from './random-helpers';
import { runWithActivator, disposeActivator } from './vmless-context';

export type { WorkflowCreateOptionsInternal } from './interfaces';
export { UpdateScope } from './update-scope';
export { overrideGlobals } from './vmless-global-overrides';
export { runWithActivator, runOutsideWorkflowContext, maybeGetActivator, isDisposed } from './vmless-context';
export { initialize, activate, concludeActivation, tryUnblockConditions } from './runtime-operations';

const OriginalDate = Date;
const originalRandom = Math.random;

export interface RuntimeModules {
  importWorkflows: typeof globalThis.__TEMPORAL__.importWorkflows;
  importInterceptors: typeof globalThis.__TEMPORAL__.importInterceptors;
  importConverters(): { payloadConverter?: PayloadConverter; failureConverter?: FailureConverter };
}

export function initRuntime(
  options: WorkflowCreateOptionsInternal,
  modules: RuntimeModules,
  onUnhandledSdkError: (activator: Activator, error: unknown) => void
): Activator {
  const activator = new Activator({
    ...options,
    info: {
      ...options.info,
      unsafe: {
        ...options.info.unsafe,
        now: OriginalDate.now,
        random: createUnsafeRandomSource(originalRandom),
      },
    },
  });
  activator.onUnhandledSdkError = (error) => onUnhandledSdkError(activator, error);
  for (const name of ['__stack_trace', '__enhanced_stack_trace']) {
    const query = activator.queryHandlers.get(name)!;
    activator.queryHandlers.set(name, {
      ...query,
      handler: () => {
        throw new Error('Workflow promise-stack queries are not supported by VM-less execution');
      },
    });
  }
  return runWithActivator(activator, () => {
    activator.rethrowSynchronously = true;
    try {
      const { payloadConverter, failureConverter } = modules.importConverters();
      if (payloadConverter != null) activator.payloadConverter = payloadConverter;
      if (failureConverter != null) activator.failureConverter = failureConverter;
      operations.initializeModules(activator, modules.importWorkflows, modules.importInterceptors);
      return activator;
    } catch (error) {
      try {
        dispose(activator);
      } catch {
        // Preserve the initialization failure if disposal also fails.
      }
      throw error;
    } finally {
      activator.rethrowSynchronously = false;
    }
  });
}

export function dispose(activator: Activator): void {
  operations.dispose(activator, () => disposeActivator(activator));
}
