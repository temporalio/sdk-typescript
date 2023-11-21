import { AnyFunc, OmitLastParam } from './type-helpers';
import { Payload } from './interfaces';

/**
 * Type of the next function for a given interceptor function
 *
 * Called from an interceptor to continue the interception chain
 */
export type Next<IF, FN extends keyof IF> = Required<IF>[FN] extends AnyFunc ? OmitLastParam<Required<IF>[FN]> : never;

/** Headers are just a mapping of header name to Payload */
export type Headers = Record<string, Payload>;

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
  for (let i = interceptors.length - 1; i >= 0; --i) {
    const interceptor = interceptors[i];
    if (interceptor[method] !== undefined) {
      const prev = next;
      // We lose type safety here because Typescript can't deduce that interceptor[method] is a function that returns
      // the same type as Next<I, M>
      next = ((input: any) => (interceptor[method] as any)(input, prev)) as any;
    }
  }
  return next;
}
