import { type Next } from '@temporalio/common/lib/interceptors';
import { getActivator } from './global-attributes';

/**
 * Compose workflow interceptors while making every `next(...)` continuation re-enter
 * the caller's current workflow-random scope before invoking downstream code.
 *
 * This prevents a temporary plugin/interceptor scope established with
 * `withRandomStream(...)` from leaking into the next interceptor or base workflow
 * runtime implementation unless that downstream code explicitly establishes its own
 * scope.
 */
export function composeInterceptors<I, M extends keyof I>(interceptors: I[], method: M, next: Next<I, M>): Next<I, M> {
  return (((input: any) => {
    const activator = getActivator();
    let composedNext: any = activator.bindCurrentRandom(next as any);
    for (let i = interceptors.length - 1; i >= 0; --i) {
      const interceptor = interceptors[i];
      if (interceptor?.[method] !== undefined) {
        const prev = activator.bindCurrentRandom(composedNext as any);
        composedNext = (nextInput: any) => (interceptor[method] as any)(nextInput, prev);
      }
    }
    return composedNext(input);
  }) as unknown) as Next<I, M>;
}
