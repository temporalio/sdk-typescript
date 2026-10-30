import type { ClientInterceptors, WorkflowClientInterceptor, WorkflowStartInput } from '@temporalio/client';
import { type InternalWorkflowStartOptions, InternalWorkflowStartOptionsSymbol } from '@temporalio/client/internal';
import { currentPropagatedNexusSerializationContext } from './context';

type CompiledWorkflowOptions = WorkflowStartInput['options'];

/**
 * Returns `options` with the active Nexus operation's serialization context attached to its
 * SDK-internal start options. Existing internal options are updated in place rather than copied,
 * because the caller reads the response link back from that object.
 */
function withPropagatedNexusSerializationContext(options: CompiledWorkflowOptions): CompiledWorkflowOptions {
  const propagatedNexusSerializationContext = currentPropagatedNexusSerializationContext();
  if (propagatedNexusSerializationContext == null) {
    return options;
  }
  const existingInternalOptions = (options as InternalWorkflowStartOptions)[InternalWorkflowStartOptionsSymbol];
  if (existingInternalOptions != null) {
    existingInternalOptions.propagatedNexusSerializationContext ??= propagatedNexusSerializationContext;
    return options;
  }
  return {
    ...options,
    [InternalWorkflowStartOptionsSymbol]: { propagatedNexusSerializationContext },
  } as CompiledWorkflowOptions;
}

/**
 * Adds the active Nexus operation's serialization context to Workflows started through the Worker's
 * Client, including the start of an Update-with-Start. These Workflows return their result and
 * failure to the Nexus caller. A no-op outside an active Nexus start operation.
 *
 * @internal
 * @hidden
 */
export const nexusWorkflowClientInterceptor: WorkflowClientInterceptor = {
  startWithDetails: (input, next) =>
    next({ ...input, options: withPropagatedNexusSerializationContext(input.options) }),
  startUpdateWithStart: (input, next) =>
    next({ ...input, workflowStartOptions: withPropagatedNexusSerializationContext(input.workflowStartOptions) }),
};

/**
 * Appends {@link nexusWorkflowClientInterceptor} to `interceptors`, so that Workflows started through
 * the resulting Client interceptors carry the current Nexus operation's serialization context.
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
