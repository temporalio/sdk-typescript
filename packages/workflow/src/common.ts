/* eslint-disable @typescript-eslint/ban-ts-comment */
import { coresdk } from '@temporalio/proto';

export function errorToUserCodeFailure(err: unknown, nonRetryable?: boolean): coresdk.common.IUserCodeFailure {
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err instanceof Error) {
    return { message: err.message, type: err.name, stackTrace: err.stack, nonRetryable };
  }

  // Default value
  return { message: 'Unknown error' };
}

/**
 * Helper for creating promises which can be manually resolved
 *
 * TODO: Move this to a shared library for node packages
 *
 * Do not use this in Workflow code, use {@link Trigger} instead
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
