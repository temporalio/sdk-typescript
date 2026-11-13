import type { Payload } from '@temporalio/common';

/**
 * Cross-realm-safe Uint8Array check.
 *
 * The workflow sandbox gets its `TextEncoder` from `node:util`, which
 * returns a `Uint8Array` tagged to the host realm — so `value instanceof
 * Uint8Array` is false against the sandbox's own `Uint8Array` global.
 * `Object.prototype.toString` crosses realm boundaries reliably.
 */
export function isUint8ArrayLike(value: unknown): value is ArrayLike<number> {
  return value != null && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

/**
 * Type guard for identifying a Payload.
 *
 * Built-in converters always set `metadata.encoding` to a Uint8Array. Requiring
 * that key (and that every metadata value / optional `data` look like
 * Uint8Array) avoids treating plain application objects with `metadata: {}`
 * as raw Payloads.
 */
export function isPayload(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { metadata?: unknown; data?: unknown };
  if (!('metadata' in v) || v.metadata == null || typeof v.metadata !== 'object' || Array.isArray(v.metadata)) {
    return false;
  }
  const metadata = v.metadata as Record<string, unknown>;
  if (!isUint8ArrayLike(metadata['encoding'])) return false;
  if (!Object.values(metadata).every((x) => isUint8ArrayLike(x))) return false;
  if ('data' in v && v.data != null && !isUint8ArrayLike(v.data)) return false;
  return true;
}
