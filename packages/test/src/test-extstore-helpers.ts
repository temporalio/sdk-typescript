/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import {
  ExternalStorage,
  StorageDriverClaim,
  type LoadedDataConverter,
  type Payload,
  type StorageDriver,
} from '@temporalio/common';
import {
  decodeReferencePayload,
  encodeReferencePayload,
  isReferencePayload,
} from '@temporalio/common/lib/converter/extstore';
import {
  encodeToPayloads,
  isLoadedDataConverter,
  loadDataConverter,
} from '@temporalio/common/lib/internal-non-workflow';

function makeConverter(externalStorage?: ExternalStorage): LoadedDataConverter {
  const loaded = loadDataConverter({ externalStorage });
  if (!isLoadedDataConverter(loaded)) throw new Error('unreachable');
  return loaded;
}

function stubDriver(name: string): StorageDriver {
  return {
    name,
    type: name,
    async store(): Promise<StorageDriverClaim[]> {
      throw new Error('not implemented');
    },
    async retrieve(): Promise<Payload[]> {
      throw new Error('not implemented');
    },
  };
}

test('loadDataConverter passes through externalStorage when set', (t) => {
  const externalStorage = new ExternalStorage({ drivers: [stubDriver('mem')] });
  const loaded = loadDataConverter({ externalStorage });
  t.is(loaded.externalStorage, externalStorage);
});

test('encodeToPayloads is a no-op when externalStorage is undefined', async (t) => {
  const converter = makeConverter(undefined);
  const payloads = await encodeToPayloads(converter, 'hello');
  t.is(payloads!.length, 1);
  t.falsy(payloads![0]!.externalPayloads?.length);
  t.false(isReferencePayload(payloads![0]!));
});

test('reference payload round-trips through canonical proto3 JSON', (t) => {
  const claim = new StorageDriverClaim({ id: 'mem-0', bucket: 'my-bucket' });
  const payload = encodeReferencePayload({ driverName: 'mem', claim, sizeBytes: 4096 });

  t.true(isReferencePayload(payload));

  const decoded = decodeReferencePayload(payload);
  t.is(decoded.driverName, 'mem');
  t.deepEqual(decoded.claimData, { id: 'mem-0', bucket: 'my-bucket' });
  t.is(decoded.sizeBytes, 4096);
});

test('isReferencePayload is true even without externalPayloads size detail', (t) => {
  const claim = new StorageDriverClaim({ id: 'mem-0' });
  const payload = encodeReferencePayload({ driverName: 'mem', claim, sizeBytes: 0 });
  delete payload.externalPayloads;
  t.true(isReferencePayload(payload));
});
