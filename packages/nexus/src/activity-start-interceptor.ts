import type { ActivityClientInterceptor } from '@temporalio/client';
import { type InternalActivityStartOptions, InternalActivityStartOptionsSymbol } from '@temporalio/client/internal';
import { currentPropagatedNexusSerializationContext, getNexusStartOperationContext } from './context';
import { pushResponseLink, requestLinksToTemporalLinks } from './operation-links';

/**
 * Adds the active Nexus operation's request ID, inbound links and serialization context to
 * Activities started through the Worker's Client. A no-op outside an active Nexus operation. A start
 * that already carries its own SDK-internal options only gets the serialization context.
 *
 * @internal
 * @hidden
 */
export const nexusActivityStartInterceptor: ActivityClientInterceptor = {
  start: async (input, next) => {
    const ctx = getNexusStartOperationContext();
    if (ctx == null) {
      return next(input);
    }
    const optionsWithInternal = input.options as InternalActivityStartOptions;
    const existingInternalOptions = optionsWithInternal[InternalActivityStartOptionsSymbol];
    const propagatedNexusSerializationContext = currentPropagatedNexusSerializationContext();
    if (existingInternalOptions != null) {
      // Set in place rather than copied: the caller reads the response link back from this object
      existingInternalOptions.propagatedNexusSerializationContext ??= propagatedNexusSerializationContext;
      return next(input);
    }
    const links = requestLinksToTemporalLinks(ctx);
    const internalOptions: NonNullable<InternalActivityStartOptions[typeof InternalActivityStartOptionsSymbol]> = {
      requestId: ctx.requestId,
      links,
      onConflictOptions: links.length > 0 ? { attachLinks: true, attachRequestId: true } : undefined,
      propagatedNexusSerializationContext,
    };
    const options: InternalActivityStartOptions = {
      ...input.options,
      [InternalActivityStartOptionsSymbol]: internalOptions,
    };
    const handle = await next({ ...input, options });
    if (internalOptions.responseLink != null) {
      pushResponseLink(ctx, internalOptions.responseLink);
    }
    return handle;
  },
};

/**
 * Appends {@link nexusActivityStartInterceptor} to `interceptors`, so that Activities started
 * through the resulting list are linked back to the current Nexus operation.
 *
 * @internal
 * @hidden
 */
export function withNexusActivityLinking(interceptors: ActivityClientInterceptor[]): ActivityClientInterceptor[] {
  return [...interceptors, nexusActivityStartInterceptor];
}
