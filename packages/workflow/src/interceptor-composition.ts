import { composeInterceptorsWith, type Next } from '@temporalio/common/lib/interceptors';
import { getActivator } from './global-attributes';

/**
 * Compose workflow interceptors while making every `next(...)` continuation re-enter
 * the workflow-random scope that was current when that continuation was created.
 *
 * This is intentionally a thin wrapper over the shared interceptor composition helper
 * in `packages/common`. The shared helper owns the actual chain-construction algorithm,
 * ordering, and `next(...)` wiring so workflow code cannot silently drift away from the
 * semantics used by the rest of the SDK.
 *
 * The workflow-specific behavior lives entirely in the `wrapNext` hook we pass into that
 * shared helper. Each `next(...)` continuation handed to a workflow interceptor is wrapped
 * with `Activator.bindCurrentRandom(...)`, which captures the currently active workflow
 * random scope, including the absence of any scoped override. When the interceptor later
 * calls `next(...)`, the wrapper restores that captured scope before entering the rest of
 * the interceptor chain or the base workflow/runtime handler.
 *
 * That is the behavior we need for `WorkflowRandomStream.with(...)`: a temporary
 * plugin/interceptor scope should apply to the plugin's own code, but it must not
 * leak through `next(...)` into downstream workflow code unless that downstream code
 * explicitly establishes its own scope.
 */
export function composeInterceptors<I, M extends keyof I>(interceptors: I[], method: M, next: Next<I, M>): Next<I, M> {
  const activator = getActivator();
  return composeInterceptorsWith(interceptors, method, next, ((wrappedNext) =>
    activator.bindCurrentRandom(wrappedNext as any)) as <F extends (...args: any[]) => any>(
    next: F
  ) => F) as unknown as Next<I, M>;
}
