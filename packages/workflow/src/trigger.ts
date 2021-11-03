import { CancellationScope } from './cancellation-scope';

/**
 * A `PromiseLike` helper which exposes its `resolve` and `reject` methods.
 *
 * Trigger is CancellationScope aware, it is linked to the current scope on
 * construction and throws when that scope is cancelled.
 *
 * Useful for e.g. waiting for unblocking a Workflow from a signal.
 *
 * @example
 * <!--SNIPSTART typescript-blocked-workflow-->
 * <!--SNIPEND-->
 */
export class Trigger<T> implements PromiseLike<T> {
  public readonly then: <TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ) => PromiseLike<TResult1 | TResult2>;

  // Typescript does not realize that the promise executor is run synchronously in the constructor
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  public readonly resolve: (value: T | PromiseLike<T>) => void;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  public readonly reject: (reason?: any) => void;

  constructor() {
    const promise = new Promise<T>((resolve, reject) => {
      const scope = CancellationScope.current();
      if (scope.consideredCancelled || scope.cancellable) {
        scope.cancelRequested.catch(reject);
      }
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.resolve = resolve;
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.reject = reject;
    });
    // Avoid unhandled rejections
    promise.catch(() => undefined);
    this.then = promise.then.bind(promise);
  }
}
