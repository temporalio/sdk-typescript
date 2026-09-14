import type { ActivityClientInterceptor } from '@temporalio/client';
import { type InternalActivityStartOptions, InternalActivityStartOptionsSymbol } from '@temporalio/client/lib/internal';
import { getNexusStartOperationContext } from './context';
import { pushResponseLink, requestLinksToTemporalLinks } from './operation-links';

/**
 * Adds the active Nexus operation's request ID and inbound links to Activities started through the
 * Worker's Client. A no-op outside an active Nexus operation, or for a start that already carries
 * its own SDK-internal options.
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
    if (existingInternalOptions != null) {
      return next(input);
    }
    const links = requestLinksToTemporalLinks(ctx);
    const internalOptions: NonNullable<InternalActivityStartOptions[typeof InternalActivityStartOptionsSymbol]> = {
      requestId: ctx.requestId,
      links,
      onConflictOptions: links.length > 0 ? { attachLinks: true, attachRequestId: true } : undefined,
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
