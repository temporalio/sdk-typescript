import type { Payload } from './interfaces';

/**
 * Generic interface for a payload cache.
 *
 * Implementations should not throw or reject. The SDK treats a failed `get` as a miss and ignores a failed `set`.
 *
 * @experimental
 */
export interface PayloadCache {
  /** Returns the payload stored under `key`, or `undefined` on a miss. */
  get(key: string): Promise<Payload | undefined>;

  /** Returns whether the cache accepted `payload`. */
  set(key: string, payload: Payload): Promise<boolean>;
}
