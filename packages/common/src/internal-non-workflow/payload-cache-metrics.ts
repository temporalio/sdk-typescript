import { temporal } from '@temporalio/proto';

import type { MetricMeter } from '../metrics';
import type { PayloadCache } from '../payload-cache';

const PayloadProto = temporal.api.common.v1.Payload;

/**
 * Wraps a {@link PayloadCache} with SDK metrics.
 *
 * @internal
 * @experimental
 */
export function withPayloadCacheMetrics(cache: PayloadCache, meter: MetricMeter): PayloadCache {
  const hit = meter.createCounter('payload_cache_lookup_hit', '', 'Payload cache lookups that returned a payload');
  const hitBytes = meter.createCounter(
    'payload_cache_lookup_hit_bytes',
    'By',
    'Total payload bytes returned by cache lookups'
  );
  const rejection = meter.createCounter(
    'payload_cache_rejection',
    '',
    'Payloads the cache declined to store, tagged by reason'
  );

  return {
    async get(key) {
      const payload = await cache.get(key);
      if (payload !== undefined) {
        const bytes = PayloadProto.encode(payload).len;
        hit.add(1);
        hitBytes.add(bytes);
      }
      return payload;
    },
    async set(key, payload) {
      try {
        const cached = await cache.set(key, payload);
        if (!cached) rejection.add(1, { reason: 'declined' });
        return cached;
      } catch (error) {
        rejection.add(1, { reason: 'error' });
        throw error;
      }
    },
  };
}
