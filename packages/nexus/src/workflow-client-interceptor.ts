import type {
  ClientInterceptors,
  WorkflowClientInterceptor,
  WorkflowStartInput,
  WorkflowStartUpdateInput,
} from '@temporalio/client';
import {
  type InternalWorkflowStartOptions,
  InternalWorkflowStartOptionsSymbol,
  type InternalWorkflowUpdateOptions,
  InternalWorkflowUpdateOptionsSymbol,
} from '@temporalio/client/internal';
import { currentPropagatedNexusSerializationContext } from './context';

type CompiledWorkflowOptions = WorkflowStartInput['options'];
type WorkflowUpdateOptions = WorkflowStartUpdateInput['options'];

/**
 * Returns `options` with the active Nexus operation's serialization context attached to the
 * SDK-internal options under `symbol`. Existing internal options are updated in place rather than
 * copied, because the caller reads the response link back from that object.
 */
function withPropagatedNexusSerializationContext<T extends object>(
  options: T,
  symbol: typeof InternalWorkflowStartOptionsSymbol | typeof InternalWorkflowUpdateOptionsSymbol
): T {
  const propagatedNexusSerializationContext = currentPropagatedNexusSerializationContext();
  if (propagatedNexusSerializationContext == null) {
    return options;
  }
  const existingInternalOptions = (options as InternalWorkflowStartOptions & InternalWorkflowUpdateOptions)[symbol];
  if (existingInternalOptions != null) {
    existingInternalOptions.propagatedNexusSerializationContext ??= propagatedNexusSerializationContext;
    return options;
  }
  return { ...options, [symbol]: { propagatedNexusSerializationContext } };
}

function startOptions(options: CompiledWorkflowOptions): CompiledWorkflowOptions {
  return withPropagatedNexusSerializationContext(options, InternalWorkflowStartOptionsSymbol);
}

function updateOptions(options: WorkflowUpdateOptions): WorkflowUpdateOptions {
  return withPropagatedNexusSerializationContext(options, InternalWorkflowUpdateOptionsSymbol);
}

/**
 * Adds the active Nexus operation's serialization context to Workflows started and Updates sent
 * through the Worker's Client, including both halves of an Update-with-Start. These return their
 * result and failure to the Nexus caller. A no-op outside an active Nexus start operation.
 *
 * @internal
 * @hidden
 */
export const nexusWorkflowClientInterceptor: WorkflowClientInterceptor = {
  startWithDetails: (input, next) => next({ ...input, options: startOptions(input.options) }),
  startUpdate: (input, next) => next({ ...input, options: updateOptions(input.options) }),
  startUpdateWithStart: (input, next) =>
    next({
      ...input,
      workflowStartOptions: startOptions(input.workflowStartOptions),
      updateOptions: updateOptions(input.updateOptions),
    }),
};

/**
 * Appends {@link nexusWorkflowClientInterceptor} to `interceptors`, so that Workflows started and
 * Updates sent through the resulting Client interceptors carry the current Nexus operation's
 * serialization context.
 *
 * @internal
 * @hidden
 */
export function withNexusWorkflowSerializationContext(
  interceptors: NonNullable<ClientInterceptors['workflow']>
): NonNullable<ClientInterceptors['workflow']> {
  if (Array.isArray(interceptors)) {
    return [...interceptors, nexusWorkflowClientInterceptor];
  }
  return {
    ...interceptors,
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    calls: [...(interceptors.calls ?? []), () => nexusWorkflowClientInterceptor],
  };
}
