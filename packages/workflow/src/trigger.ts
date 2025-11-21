import { CancellationScope } from './cancellation-scope';
import { untrackPromise } from './stack-helpers';

/**
 * A `PromiseLike` helper which exposes its `resolve` and `reject` methods.
 *
 * Trigger is CancellationScope-aware: it is linked to the current scope on
 * construction and throws when that scope is cancelled.
 *
 * Useful for e.g. waiting for unblocking a Workflow from a Signal.
 *
 * @example
 * <!--SNIPSTART typescript-trigger-workflow-->
 * <!--SNIPEND-->
 */
export class Trigger<T> implements PromiseLike<T> {
  // Typescript does not realize that the promise executor is run synchronously in the constructor
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  public readonly resolve: (value: T | PromiseLike<T>) => void;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  public readonly reject: (reason?: any) => void;
  protected readonly promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      const scope = CancellationScope.current();
      if (scope.cancellable) {
        untrackPromise(scope.cancelRequested.catch(reject));
      }
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.resolve = resolve;
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.reject = reject;
    });
    // Avoid unhandled rejections
    untrackPromise(this.promise.catch(() => undefined));
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}
