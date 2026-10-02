import { temporal } from '@temporalio/proto';

import { ValueError } from './errors';
import type { Payload } from './interfaces';
import type { PayloadCache } from './payload-cache';

const PayloadProto = temporal.api.common.v1.Payload;

/** @see InMemoryPayloadCacheOptions.maxTotalBytes */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Limits for {@link InMemoryPayloadCache}.
 *
 * @experimental
 */
export interface InMemoryPayloadCacheOptions {
  /** Total encoded-payload byte budget across all entries. Must be a non-negative safe integer. @default 64 MiB */
  maxTotalBytes?: number;
  /** Maximum number of entries. Must be a non-negative safe integer. @default 10,000 */
  maxEntries?: number;
}

interface Entry {
  encodedPayload: Uint8Array;
}

/**
 * In-memory, LRU {@link PayloadCache}. This is the default payload cache.
 *
 * @experimental
 */
export class InMemoryPayloadCache implements PayloadCache {
  private readonly entries = new Map<string, Entry>();
  private currentBytes = 0;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;

  constructor(
    { maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES, maxEntries = DEFAULT_MAX_ENTRIES }: InMemoryPayloadCacheOptions = {}
  ) {
    assertNonNegativeInteger('maxTotalBytes', maxTotalBytes);
    assertNonNegativeInteger('maxEntries', maxEntries);
    this.maxTotalBytes = maxTotalBytes;
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<Payload | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return PayloadProto.decode(new Uint8Array(entry.encodedPayload));
  }

  async set(key: string, payload: Payload): Promise<boolean> {
    const encodedPayload = PayloadProto.encode(payload).finish();
    if (encodedPayload.byteLength > this.maxTotalBytes || this.maxEntries === 0) return false;

    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.currentBytes -= existing.encodedPayload.byteLength;
      this.entries.delete(key);
    }

    while (
      this.entries.size >= this.maxEntries ||
      this.currentBytes + encodedPayload.byteLength > this.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.currentBytes -= this.entries.get(oldest.value)?.encodedPayload.byteLength ?? 0;
      this.entries.delete(oldest.value);
    }

    this.entries.set(key, { encodedPayload });
    this.currentBytes += encodedPayload.byteLength;
    return true;
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValueError(`InMemoryPayloadCacheOptions.${name} must be a non-negative safe integer, got ${value}`);
  }
}
