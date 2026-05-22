import test from 'ava';
import {
  DEFAULT_PAYLOAD_SIZE_THRESHOLD,
  ExternalStorage,
  type StorageDriver,
  type StorageDriverClaim,
  type StorageDriverRetrieveContext,
  type StorageDriverStoreContext,
  ValueError,
} from '@temporalio/common';
import type { Payload } from '@temporalio/common';

function stubDriver(name: string, type = name): StorageDriver {
  return {
    name,
    type,
    async store(_ctx: StorageDriverStoreContext, _payloads: Payload[]): Promise<StorageDriverClaim[]> {
      throw new Error('not implemented');
    },
    async retrieve(_ctx: StorageDriverRetrieveContext, _claims: StorageDriverClaim[]): Promise<Payload[]> {
      throw new Error('not implemented');
    },
  };
}

test('ExternalStorage with one driver and no selector is valid', (t) => {
  const driver = stubDriver('only');
  const config = new ExternalStorage({ drivers: [driver] });
  t.is(config.drivers.length, 1);
  t.is(config.drivers[0], driver);
  t.is(config.driverSelector, undefined);
  t.is(config.payloadSizeThreshold, DEFAULT_PAYLOAD_SIZE_THRESHOLD);
  t.is(config.getDriver('only'), driver);
});

test('ExternalStorage rejects an empty driver list', (t) => {
  t.throws(() => new ExternalStorage({ drivers: [] }), {
    instanceOf: ValueError
  });
});

test('ExternalStorage rejects duplicate driver names', (t) => {
  t.throws(() => new ExternalStorage({ drivers: [stubDriver('dup'), stubDriver('dup')] }), {
    instanceOf: ValueError
  });
});

test('ExternalStorage requires a driverSelector when multiple drivers are registered', (t) => {
  t.throws(() => new ExternalStorage({ drivers: [stubDriver('a'), stubDriver('b')] }), {
    instanceOf: ValueError
  });
});

test('ExternalStorage with multiple drivers and a selector is valid', (t) => {
  const a = stubDriver('a');
  const b = stubDriver('b');
  const config = new ExternalStorage({
    drivers: [a, b],
    driverSelector: () => a,
  });
  t.is(config.drivers.length, 2);
  t.is(config.getDriver('a'), a);
  t.is(config.getDriver('b'), b);
});

test('ExternalStorage accepts payloadSizeThreshold = 0', (t) => {
  const config = new ExternalStorage({ drivers: [stubDriver('only')], payloadSizeThreshold: 0 });
  t.is(config.payloadSizeThreshold, 0);
});

test('ExternalStorage rejects negative payloadSizeThreshold', (t) => {
  t.throws(() => new ExternalStorage({ drivers: [stubDriver('only')], payloadSizeThreshold: -1 }), {
    instanceOf: ValueError
  });
});

test('ExternalStorage rejects non-finite payloadSizeThreshold', (t) => {
  t.throws(
    () =>
      new ExternalStorage({
        drivers: [stubDriver('only')],
        payloadSizeThreshold: Number.POSITIVE_INFINITY,
      }),
    {
      instanceOf: ValueError
    }
  );
});

test('ExternalStorage rejects a driver with an empty name', (t) => {
  t.throws(() => new ExternalStorage({ drivers: [stubDriver('')] }), {
    instanceOf: ValueError
  });
});
