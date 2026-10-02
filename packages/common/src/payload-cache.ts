import type { Payload } from './interfaces';

/**
 * Generic interface for a payload cache
 *
 * @experimental
 */
export interface PayloadCache {
  /** Returns the payload stored under `key`, or `undefined` on a miss. */
  get(key: string): Promise<Payload | undefined>;

  /** Returns whether the cache accepted `payload`. Rejects if the cache operation failed. */
  set(key: string, payload: Payload): Promise<boolean>;
}
