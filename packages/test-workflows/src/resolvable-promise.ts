/**
 * Helper for creating promises which can be manually resolved
 * Copied from workflow/common
 */
export class ResolvablePromise<T> implements PromiseLike<T> {
  public readonly then: <TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ) => PromiseLike<TResult1 | TResult2>;

  // @ts-ignore
  public readonly resolve: (value: T | PromiseLike<T>) => void;
  // @ts-ignore
  public readonly reject: (reason?: any) => void;

  constructor() {
    const promise = new Promise<T>((resolve, reject) => {
      // @ts-ignore
      this.resolve = resolve;
      // @ts-ignore
      this.reject = reject;
    });
    this.then = promise.then.bind(promise);
  }
}
