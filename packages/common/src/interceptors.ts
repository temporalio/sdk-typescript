import type { AnyFunc, OmitLastParam } from './type-helpers';
import type { Payload } from './interfaces';

/**
 * Type of the next function for a given interceptor function
 *
 * Called from an interceptor to continue the interception chain
 */
export type Next<IF, FN extends keyof IF> = Required<IF>[FN] extends AnyFunc ? OmitLastParam<Required<IF>[FN]> : never;

/** Headers are just a mapping of header name to Payload */
export type Headers = Record<string, Payload>;

type WrapNext = <F extends AnyFunc>(next: F) => F;

/**
 * Shared implementation for interceptor chaining.
 *
 * The workflow package needs one small behavioral extension over the generic interceptor
 * semantics: every `next(...)` continuation it hands to workflow interceptors must first
 * restore the workflow random scope that was current when that continuation was created.
 *
 * We keep the chain-construction loop here as the single source of truth so ordering and
 * basic composition behavior cannot drift between the generic implementation used by client,
 * worker, activity, and nexus code and the workflow-specific implementation that decorates
 * `next(...)` at each boundary. The only behavior that varies between callers is the
 * `wrapNext` hook: most packages use the identity wrapper, while workflow code supplies a
 * wrapper that re-enters the captured workflow async-local random scope.
 */
export function composeInterceptorsWith<I, M extends keyof I>(
  interceptors: I[],
  method: M,
  next: Next<I, M>,
  wrapNext: WrapNext
): Next<I, M> {
  let composedNext: any = next;
  for (let i = interceptors.length - 1; i >= 0; --i) {
    const interceptor = interceptors[i];
    if (interceptor?.[method] !== undefined) {
      const prev = wrapNext(composedNext);
      // We lose type safety here because Typescript can't deduce that interceptor[method] is a function that returns
      // the same type as Next<I, M>
      composedNext = ((input: any) => (interceptor[method] as any)(input, prev)) as any;
    }
  }
  return composedNext;
}

/**
 * Compose all interceptor methods into a single function.
 *
 * Calling the composed function results in calling each of the provided interceptor, in order (from the first to
 * the last), followed by the original function provided as argument to `composeInterceptors()`.
 *
 * @param interceptors a list of interceptors
 * @param method the name of the interceptor method to compose
 * @param next the original function to be executed at the end of the interception chain
 */
// ts-prune-ignore-next (imported via lib/interceptors)
export function composeInterceptors<I, M extends keyof I>(interceptors: I[], method: M, next: Next<I, M>): Next<I, M> {
  return composeInterceptorsWith(interceptors, method, next, ((wrappedNext) => wrappedNext) as WrapNext);
}
