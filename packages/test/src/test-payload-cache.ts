/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test, { type ExecutionContext } from 'ava';
import Long from 'long';
import type { MetricCounter, MetricMeter, MetricTags, Payload, PayloadCache } from '@temporalio/common';
import { ValueError } from '@temporalio/common';
import { Client, WorkflowClient } from '@temporalio/client';
import { ExternalStorage } from '@temporalio/common/lib/converter/extstore';
import {
  decodeReferencePayload,
  externalStorageClaimCacheKey,
  externalStorageRetrieveVisitOptions,
  externalStorageStoreVisitOptions,
  ExternalStorageRunner,
  InMemoryPayloadCache,
  withPayloadCacheMetrics,
} from '@temporalio/common/lib/internal-non-workflow';
import { encode } from '@temporalio/common/lib/encoding';
import { METADATA_ENCODING_KEY } from '@temporalio/common/lib/converter/types';
import { temporal } from '@temporalio/proto';
import { makeFakeDriver } from './extstore-fake-driver';

const PayloadProto = temporal.api.common.v1.Payload;

/** A payload whose accounted size equals `bytes` exactly (no metadata). */
function payloadOfSize(bytes: number, fill = 0): Payload {
  return { data: new Uint8Array(bytes).fill(fill) };
}

/** A reference-worthy payload above the External Storage threshold used in these tests. */
function makePayload(bodyBytes: number, fill = 0): Payload {
  return {
    metadata: { [METADATA_ENCODING_KEY]: encode('binary/plain') },
    data: new Uint8Array(bodyBytes).fill(fill),
  };
}

function assertPayloadEqual(t: ExecutionContext, actual: Payload, expected: Payload): void {
  t.deepEqual(PayloadProto.encode(actual).finish(), PayloadProto.encode(expected).finish());
}

// InMemoryPayloadCache ////////////////////////////////////////////////////////////////////////////

test('InMemoryPayloadCache round-trips a stored payload', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000 });
  const p = payloadOfSize(10);
  t.true(await cache.set('k', p));
  assertPayloadEqual(t, (await cache.get('k'))!, p);
});

test('InMemoryPayloadCache resolves undefined on a miss', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000 });
  t.is(await cache.get('absent'), undefined);
});

test('InMemoryPayloadCache rejects an entry larger than its total budget', async (t) => {
  const fits = payloadOfSize(10);
  const cache = new InMemoryPayloadCache({ maxTotalBytes: PayloadProto.encode(fits).len });
  t.true(await cache.set('fits', fits));
  t.false(await cache.set('toobig', payloadOfSize(11)));
  t.is(await cache.get('toobig'), undefined);
  t.truthy(await cache.get('fits'));
});

test('InMemoryPayloadCache evicts least-recently-used entries to stay under the byte budget', async (t) => {
  const payload = payloadOfSize(10);
  const cache = new InMemoryPayloadCache({ maxTotalBytes: PayloadProto.encode(payload).len * 3 });
  await cache.set('a', payloadOfSize(10));
  await cache.set('b', payloadOfSize(10));
  await cache.set('c', payloadOfSize(10));
  await cache.set('d', payloadOfSize(10));
  t.is(await cache.get('a'), undefined);
  t.truthy(await cache.get('b'));
  t.truthy(await cache.get('c'));
  t.truthy(await cache.get('d'));
});

test('InMemoryPayloadCache.get promotes an entry to most-recently-used', async (t) => {
  const payload = payloadOfSize(10);
  const cache = new InMemoryPayloadCache({ maxTotalBytes: PayloadProto.encode(payload).len * 3 });
  await cache.set('a', payloadOfSize(10));
  await cache.set('b', payloadOfSize(10));
  await cache.set('c', payloadOfSize(10));
  t.truthy(await cache.get('a')); // 'a' is now most-recently-used, 'b' is LRU
  await cache.set('d', payloadOfSize(10)); // evicts 'b', not 'a'
  t.truthy(await cache.get('a'));
  t.is(await cache.get('b'), undefined);
});

test('InMemoryPayloadCache.set on an existing key does not double-count bytes', async (t) => {
  const payloadA = payloadOfSize(10);
  const payloadB = payloadOfSize(2);
  const maxTotalBytes = PayloadProto.encode(payloadA).len + PayloadProto.encode(payloadB).len;
  const cache = new InMemoryPayloadCache({ maxTotalBytes });
  await cache.set('a', payloadA);
  await cache.set('a', payloadA);
  t.true(await cache.set('b', payloadB));
  t.truthy(await cache.get('a'));
  t.truthy(await cache.get('b'));
});

test('InMemoryPayloadCache does not share entry bytes with the caller that stored them', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000 });
  const original = { data: new Uint8Array([1, 2, 3]), metadata: { enc: new Uint8Array([9]) } };
  await cache.set('k', original);

  original.data[0] = 99;
  original.metadata.enc[0] = 99;

  const cached = (await cache.get('k'))!;
  t.is(cached.data![0], 1);
  t.is(cached.metadata!.enc![0], 9);
});

test('InMemoryPayloadCache does not share entry bytes with the caller that read them', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000 });
  await cache.set('k', { data: new Uint8Array([1, 2, 3]) });

  const first = (await cache.get('k'))!;
  first.data![0] = 99;

  const second = (await cache.get('k'))!;
  t.is(second.data![0], 1);
});

test('InMemoryPayloadCache clones the complete payload', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000 });
  const original: Payload = {
    data: new Uint8Array([1]),
    externalPayloads: [{ sizeBytes: Long.fromNumber(42) }],
  };
  await cache.set('k', original);

  original.externalPayloads![0]!.sizeBytes = Long.fromNumber(99);
  const first = (await cache.get('k'))!;
  t.true(Long.fromValue(first.externalPayloads![0]!.sizeBytes!).equals(42));

  first.externalPayloads![0]!.sizeBytes = Long.fromNumber(100);
  const second = (await cache.get('k'))!;
  t.true(Long.fromValue(second.externalPayloads![0]!.sizeBytes!).equals(42));
});

test('InMemoryPayloadCache does not retain the backing buffer of a partial view', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000 });
  const backing = new Uint8Array(100_000).fill(9);
  // What protobuf decoding hands us: a small window onto a much larger buffer.
  const view = backing.subarray(10, 30);
  t.is(view.buffer.byteLength, 100_000);

  await cache.set('k', { data: view });
  const cached = (await cache.get('k'))!;
  t.deepEqual(cached.data, view);
  t.true(cached.data!.buffer.byteLength < backing.buffer.byteLength);
});

test('InMemoryPayloadCache budgets a partial view by its own length, not its buffer', async (t) => {
  const backing = new Uint8Array(100_000);
  const payload = { data: backing.subarray(0, 10) };
  const cache = new InMemoryPayloadCache({ maxTotalBytes: PayloadProto.encode(payload).len });
  t.true(await cache.set('k', { data: backing.subarray(0, 10) }));
});

test('InMemoryPayloadCache does not apply a per-entry fraction to the default budget', async (t) => {
  const cache = new InMemoryPayloadCache();
  t.true(await cache.set('fits', payloadOfSize(16 * 1024 * 1024)));
});

test('InMemoryPayloadCache bounds zero-byte entries by count', async (t) => {
  const cache = new InMemoryPayloadCache({ maxTotalBytes: 1000, maxEntries: 2 });
  await cache.set('a', {});
  await cache.set('b', {});
  await cache.set('c', {});

  t.is(await cache.get('a'), undefined);
  t.truthy(await cache.get('b'));
  t.truthy(await cache.get('c'));
});

for (const [name, value] of [
  ['maxTotalBytes', -1],
  ['maxTotalBytes', Number.NaN],
  ['maxTotalBytes', Number.POSITIVE_INFINITY],
  ['maxTotalBytes', 1.5],
  ['maxEntries', -1],
  ['maxEntries', Number.NaN],
  ['maxEntries', Number.POSITIVE_INFINITY],
  ['maxEntries', 1.5],
] as const) {
  test(`InMemoryPayloadCache rejects invalid ${name}: ${value}`, (t) => {
    t.throws(() => new InMemoryPayloadCache({ [name]: value }), { instanceOf: ValueError });
  });
}

test('externalStorageClaimCacheKey is independent of claim key insertion order', (t) => {
  const first = externalStorageClaimCacheKey('s3', { bucket: 'abc', key: '1' });
  const reordered = externalStorageClaimCacheKey('s3', { key: '1', bucket: 'abc' });

  t.is(
    externalStorageClaimCacheKey('aws-s3', { bucket: 'abc', key: '1' }),
    'v0/temporal/extstore/6:aws-s36:bucket3:abc3:key1:1'
  );
  t.is(reordered, first);
  t.not(externalStorageClaimCacheKey('gcs', { bucket: 'abc', key: '1' }), first);
  t.not(externalStorageClaimCacheKey('s3', { bucket: 'abc', key: '2' }), first);
  t.not(externalStorageClaimCacheKey('s3', { a: '1:b1:2' }), externalStorageClaimCacheKey('s3', { a: '1', b: '2' }));
  t.is(externalStorageClaimCacheKey('d', { k: 'é' }), 'v0/temporal/extstore/1:d1:k2:é');
  t.is(externalStorageClaimCacheKey('d', { '\uFF01': 'a', '\u{1D11E}': 'b' }), 'v0/temporal/extstore/1:d3:！1:a4:𝄞1:b');
});

// ExternalStorageRunner integration ///////////////////////////////////////////////////////////////

test('separate visits share a payload cache without sharing a runner', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 96 });
  const payloadCache = new InMemoryPayloadCache();
  const original = makePayload(256, 7);

  const reference = await externalStorageStoreVisitOptions({
    externalStorage,
    payloadCache,
  }).transformPayload(original, undefined);
  const restored = await externalStorageRetrieveVisitOptions({
    externalStorage,
    payloadCache,
  }).transformPayload(reference, undefined);

  assertPayloadEqual(t, restored, original);
  t.is(driver.retrieveCalls.length, 0);
});

/** `payloadCache` is required rather than defaulted so that passing `undefined` really means no cache. */
function runnerWith(payloadCache: PayloadCache | undefined) {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 96 });
  return { driver, externalStorage, runner: new ExternalStorageRunner(externalStorage, { payloadCache }) };
}

test('store populates the cache so a later retrieve skips the driver', async (t) => {
  const { driver, runner } = runnerWith(new InMemoryPayloadCache());
  const original = makePayload(256, 7);
  const [reference] = await runner.store([original]);

  const [restored] = await runner.retrieve([reference]);
  assertPayloadEqual(t, restored, original);
  t.is(driver.retrieveCalls.length, 0); // served from cache, driver never queried
});

test('a cold-cache retrieve falls back to the driver, then warms the cache', async (t) => {
  const { driver, runner } = runnerWith(new InMemoryPayloadCache());
  const [reference] = await runner.store([makePayload(256, 3)]);

  // Fresh runner with an empty cache: the store-side population did not reach it.
  const cold = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 96 }), {
    payloadCache: new InMemoryPayloadCache(),
  });
  await cold.retrieve([reference]);
  t.is(driver.retrieveCalls.length, 1); // miss -> one driver fetch

  await cold.retrieve([reference]);
  t.is(driver.retrieveCalls.length, 1); // now warm -> no second fetch
});

test('a mixed-cache retrieve only sends misses to the driver', async (t) => {
  const { driver, externalStorage } = runnerWith(undefined);
  const writer = new ExternalStorageRunner(externalStorage);
  const originalPayloads = [makePayload(256, 3), makePayload(256, 7)];
  const references = await writer.store(originalPayloads);

  const cache = new InMemoryPayloadCache();
  const cachedReference = decodeReferencePayload(references[0]!);
  await cache.set(
    externalStorageClaimCacheKey(cachedReference.driverName, cachedReference.claimData),
    originalPayloads[0]!
  );

  const reader = new ExternalStorageRunner(externalStorage, { payloadCache: cache });
  const restoredPayloads = await reader.retrieve(references);

  for (const [index, payload] of restoredPayloads.entries()) {
    assertPayloadEqual(t, payload, originalPayloads[index]!);
  }
  t.is(driver.retrieveCalls.length, 1);
  t.is(driver.retrieveCalls[0]!.claims.length, 1);
});

test('with no cache, every retrieve queries the driver', async (t) => {
  const { driver, runner } = runnerWith(undefined);
  const [reference] = await runner.store([makePayload(256)]);

  await runner.retrieve([reference]);
  await runner.retrieve([reference]);
  t.is(driver.retrieveCalls.length, 2);
});

test('a cache that fails on get is treated as a miss', async (t) => {
  const failing: PayloadCache = {
    get: () => Promise.reject(new Error('cache backend down')),
    set: () => Promise.resolve(true),
  };
  const { driver, runner } = runnerWith(failing);
  const [reference] = await runner.store([makePayload(256, 5)]);

  const [restored] = await runner.retrieve([reference]);
  t.deepEqual(restored, makePayload(256, 5)); // fell through to the driver, correct bytes
  t.is(driver.retrieveCalls.length, 1);
});

test('a cache that fails on set neither blocks nor fails the store', async (t) => {
  const failing: PayloadCache = {
    get: () => Promise.resolve(undefined),
    set: () => Promise.reject(new Error('cache backend down')),
  };
  const { runner } = runnerWith(failing);

  const stored = await runner.store([makePayload(256)]);
  t.truthy(stored[0]);
});

test('a cache that never settles on set does not delay the store', async (t) => {
  const neverSettles: PayloadCache = {
    get: () => Promise.resolve(undefined),
    set: () => new Promise(() => {}),
  };
  const { runner } = runnerWith(neverSettles);

  // Populating the cache is an optimization for later reads; awaiting it here would hang the store.
  const [reference] = await runner.store([makePayload(256)]);
  t.truthy(reference);
});

test('withPayloadCacheMetrics records cache outcomes without changing the cache contract', async (t) => {
  const records = new Map<string, { value: number; tags?: MetricTags }[]>();
  const meter: MetricMeter = {
    createCounter(name): MetricCounter {
      const counterRecords: { value: number; tags?: MetricTags }[] = [];
      records.set(name, counterRecords);
      const counter: MetricCounter = {
        name,
        kind: 'counter',
        valueType: 'int',
        add(value, tags) {
          counterRecords.push({ value, tags });
        },
        withTags() {
          return counter;
        },
      };
      return counter;
    },
    createHistogram() {
      throw new Error('Not implemented');
    },
    createGauge() {
      throw new Error('Not implemented');
    },
    withTags() {
      return this;
    },
  };
  const payload = payloadOfSize(10);
  const cache = withPayloadCacheMetrics(
    new InMemoryPayloadCache({ maxTotalBytes: PayloadProto.encode(payload).len }),
    meter
  );

  await cache.set('hit', payload);
  await cache.get('hit');
  await cache.set('too-big', payloadOfSize(11));

  t.deepEqual(records.get('payload_cache_lookup_hit'), [{ value: 1, tags: undefined }]);
  t.deepEqual(records.get('payload_cache_lookup_hit_bytes'), [
    { value: PayloadProto.encode(payload).len, tags: undefined },
  ]);
  t.deepEqual(records.get('payload_cache_rejection'), [{ value: 1, tags: { reason: 'declined' } }]);
});

test('Client shares a custom payload cache across subclients', (t) => {
  const payloadCache: PayloadCache = {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(true),
  };
  const client = new Client({ payloadCache });

  t.is(client.options.payloadCache, payloadCache);
  t.is(client.workflow.options.payloadCache, payloadCache);
  t.is(client.activity.options.payloadCache, payloadCache);
  t.is(client.schedule.options.payloadCache, payloadCache);
  t.is(client.taskQueue.options.payloadCache, payloadCache);
  t.is(client.nexus.options.payloadCache, payloadCache);
});

test('standalone clients create a default payload cache and allow disabling it', (t) => {
  t.truthy(new WorkflowClient().options.payloadCache);
  t.is(new WorkflowClient({ payloadCache: false }).options.payloadCache, undefined);
});

test('Client disables the payload cache across subclients', (t) => {
  const client = new Client({ payloadCache: false });

  t.is(client.options.payloadCache, undefined);
  t.is(client.workflow.options.payloadCache, undefined);
  t.is(client.activity.options.payloadCache, undefined);
  t.is(client.schedule.options.payloadCache, undefined);
  t.is(client.taskQueue.options.payloadCache, undefined);
  t.is(client.nexus.options.payloadCache, undefined);
});
