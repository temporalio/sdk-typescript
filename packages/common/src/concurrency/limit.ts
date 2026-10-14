import { Semaphore } from './semaphore';

/**
 * Runs `fn` once a permit is available and releases the permit when it settles.
 * Following the shape of plimit's limit here.
 *
 * @internal
 */
export type ConcurrencyLimit = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Creates a {@link ConcurrencyLimit} allowing at most `concurrency` functions to run at once backed
 * by a {@link Semaphore}.
 *
 * @internal
 */
export function limit(concurrency: number): ConcurrencyLimit {
  const semaphore = new Semaphore(Math.max(1, concurrency));
  return async (fn) => {
    await semaphore.acquire();
    try {
      return await fn();
    } finally {
      semaphore.release();
    }
  };
}

/**
 * Creates a {@link ConcurrencyLimit} that runs one function at a time.
 *
 * @internal
 */
export function sequential(): ConcurrencyLimit {
  return limit(1);
}
