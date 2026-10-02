import test from 'ava';
import type { Payload, PayloadCache } from '@temporalio/common';
import { Runtime } from '@temporalio/worker';
import { compileWorkerOptions, toNativeWorkerOptions } from '@temporalio/worker/lib/worker-options';
import { ExternalStorage, type StorageDriver } from '@temporalio/common/lib/converter/extstore';
import { defaultOptions } from './mock-native-worker';

/** Minimal driver whose reported `type` is independent of its (unique) `name`. */
function driver(name: string, type: string): StorageDriver {
  return { name, type, store: async () => [], retrieve: async () => [] };
}

/** Distinct storage driver types the native worker config would report via the worker heartbeat. */
function reportedDriverTypes(externalStorage?: ExternalStorage): string[] {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions(defaultOptions, runtime.logger, runtime.metricMeter);
  const native = toNativeWorkerOptions({
    ...compiled,
    buildId: 'test-build-id',
    loadedDataConverter: { ...compiled.loadedDataConverter, externalStorage },
  });
  return native.storageDrivers;
}

function compilePayloadCache(payloadCache?: PayloadCache | false): PayloadCache | undefined {
  const runtime = Runtime.instance();
  return compileWorkerOptions({ ...defaultOptions, payloadCache }, runtime.logger, runtime.metricMeter).payloadCache;
}

test('creates a payload cache by default', (t) => {
  t.truthy(compilePayloadCache());
});

test('disables the payload cache when configured with false', (t) => {
  t.is(compilePayloadCache(false), undefined);
});

test('wraps a user-provided payload cache transparently', async (t) => {
  const entries = new Map<string, Payload>();
  const userCache: PayloadCache = {
    async get(key) {
      return entries.get(key);
    },
    async set(key, payload) {
      entries.set(key, payload);
      return true;
    },
  };
  Object.freeze(userCache);
  const cache = compilePayloadCache(userCache)!;
  const payload = { data: new Uint8Array([1, 2, 3]) };

  t.true(await cache.set('key', payload));
  t.is(await cache.get('key'), payload);
});

test('reports no storage drivers when external storage is unset', (t) => {
  t.deepEqual(reportedDriverTypes(undefined), []);
});

test('reports each configured driver type', (t) => {
  const externalStorage = new ExternalStorage({
    drivers: [driver('primary', 'aws.s3driver'), driver('backup', 'gcp.gcsdriver')],
    driverSelector: () => null,
  });
  t.deepEqual(reportedDriverTypes(externalStorage).sort(), ['aws.s3driver', 'gcp.gcsdriver']);
});

test('dedups repeated driver types across distinct drivers', (t) => {
  const externalStorage = new ExternalStorage({
    drivers: [driver('east', 'aws.s3driver'), driver('west', 'aws.s3driver')],
    driverSelector: () => null,
  });
  t.deepEqual(reportedDriverTypes(externalStorage), ['aws.s3driver']);
});
