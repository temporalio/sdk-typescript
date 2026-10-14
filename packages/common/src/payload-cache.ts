import type { Payload } from './interfaces';

/**
 * Generic interface for a payload cache
 *
 * @experimental
 */
export interface PayloadCache {
  /** Returns the payload stored under `key`, or `undefined` on a miss. The SDK treats a rejection as a miss. */
  get(key: string): Promise<Payload | undefined>;

  /** Returns whether the cache accepted `payload`. The SDK ignores rejections. */
  set(key: string, payload: Payload): Promise<boolean>;
}
