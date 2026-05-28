/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import {
  ExternalStorage,
  ExternalStorageDriverArityMismatchError,
  ExternalStorageDriverNotFoundError,
  ExternalStorageDriverOperationFailedError,
  ExternalStorageIntegrityCheckFailedError,
  ExternalStorageNotConfiguredError,
  ExternalStorageSelectorInvalidDriverError,
  type Payload,
} from '@temporalio/common';
import {
  runExternalRetrieve,
  runExternalStore,
} from '@temporalio/common/lib/internal-non-workflow/external-storage-runner';
import { isReferencePayload } from '@temporalio/common/lib/converter/extstore';
import { encode } from '@temporalio/common/lib/encoding';
import { METADATA_ENCODING_KEY } from '@temporalio/common/lib/converter/types';
import { makeFakeDriver } from './extstore-fake-driver';

/** Build a Payload whose proto-encoded size is at least `bodyBytes`. */
function makePayload(bodyBytes: number): Payload {
  return {
    metadata: { [METADATA_ENCODING_KEY]: encode('binary/plain') },
    data: new Uint8Array(bodyBytes),
  };
}

test('runExternalStore leaves payloads inline when below the threshold', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const smallPayload = makePayload(8);

  const result = await runExternalStore({ externalStorage, payloads: [smallPayload] });

  t.is(driver.storeCalls.length, 0);
  t.deepEqual(result, [smallPayload]);
});

test('runExternalStore offloads payloads above the threshold via the single-driver shortcut', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 32 });
  const bigPayload = makePayload(128);

  const result = await runExternalStore({ externalStorage, payloads: [bigPayload] });

  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.payloads.length, 1);
  t.true(isReferencePayload(result[0]!));
});

test('runExternalStore with payloadSizeThreshold=0 stores every payload', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const tinyPayload = makePayload(0);

  const result = await runExternalStore({ externalStorage, payloads: [tinyPayload, tinyPayload] });

  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.payloads.length, 2);
  t.true(isReferencePayload(result[0]!));
  t.true(isReferencePayload(result[1]!));
});

// make sure runExternalStore doesn't do unexpected batching or delayed delivery of payloads
test('runExternalStore batches all payloads in a single store request', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const payloadA = makePayload(2);
  const payloadB = makePayload(3);

  await runExternalStore({ externalStorage, payloads: [payloadA, payloadB] });
  t.is(driver.storeCalls.length, 1);
  await runExternalStore({ externalStorage, payloads: [payloadA] });
  await runExternalStore({ externalStorage, payloads: [payloadB] });
  t.is(driver.storeCalls.length, 3);
});

test('runExternalStore selector routes to the chosen driver and groups by name', async (t) => {
  const driverA = makeFakeDriver({ name: 'a' });
  const driverB = makeFakeDriver({ name: 'b' });
  const externalStorage = new ExternalStorage({
    drivers: [driverA, driverB],
    payloadSizeThreshold: 0,
    driverSelector: (_, p) => (p.data!.length % 2 === 0 ? driverA : driverB),
  });
  const evenPayloadA = makePayload(2);
  const oddPayload = makePayload(3);
  const evenPayloadB = makePayload(4);

  await runExternalStore({ externalStorage, payloads: [evenPayloadA, oddPayload, evenPayloadB] });

  t.is(driverA.storeCalls[0]!.payloads.length, 2); // evenPayloadA, evenPayloadB
  t.is(driverB.storeCalls[0]!.payloads.length, 1); // oddPayload
});

test('runExternalStore selector returning null leaves the payload inline', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({
    drivers: [driver],
    payloadSizeThreshold: 0,
    driverSelector: () => null,
  });

  const originalPayload = makePayload(64);
  const result = await runExternalStore({ externalStorage, payloads: [originalPayload] });

  t.is(driver.storeCalls.length, 0);
  t.deepEqual(result, [originalPayload]);
});

test('runExternalStore throws TMPRL1109 when selector returns an unregistered driver', async (t) => {
  const registeredDriver = makeFakeDriver({ name: 'a' });
  const strangerDriver = makeFakeDriver({ name: 'a' }); // same name, different identity
  const externalStorage = new ExternalStorage({
    drivers: [registeredDriver],
    payloadSizeThreshold: 0,
    driverSelector: () => strangerDriver,
  });

  await t.throwsAsync(() => runExternalStore({ externalStorage, payloads: [makePayload(1)] }), {
    instanceOf: ExternalStorageSelectorInvalidDriverError,
    message: /TMPRL1109/,
  });
});

test('runExternalStore wraps driver errors in TMPRL1107', async (t) => {
  const boom = new Error('disk full');
  const driver = makeFakeDriver({ name: 's3', onStore: () => Promise.reject(boom) });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });

  const err = await t.throwsAsync(() => runExternalStore({ externalStorage, payloads: [makePayload(1)] }), {
    instanceOf: ExternalStorageDriverOperationFailedError,
    message: /TMPRL1107/,
  });
  t.is(err!.cause, boom);
  t.is(err!.operation, 'store');
});

test('runExternalStore raises TMPRL1108 on claim arity mismatch', async (t) => {
  const driver = makeFakeDriver({ name: 's3', onStore: () => [] });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });

  await t.throwsAsync(() => runExternalStore({ externalStorage, payloads: [makePayload(1)] }), {
    instanceOf: ExternalStorageDriverArityMismatchError,
    message: /TMPRL1108/,
  });
});

test('runExternalStore aborts sibling drivers on first failure', async (t) => {
  let driverBAborted = false;
  const driverA = makeFakeDriver({ name: 'a', onStore: () => Promise.reject(new Error('boom')) });
  const driverB = makeFakeDriver({
    name: 'b',
    onStore: (payloads) =>
      new Promise((resolve, reject) => {
        const ctxAbort = driverB.storeCalls[driverB.storeCalls.length - 1]!.context.abortSignal!;
        ctxAbort.addEventListener('abort', () => {
          driverBAborted = true;
          reject(new Error('aborted'));
        });
        // never resolves on its own; only the abort path settles it
        void payloads;
        void resolve;
      }),
  });
  const externalStorage = new ExternalStorage({
    drivers: [driverA, driverB],
    payloadSizeThreshold: 0,
    driverSelector: (_ctx, p) => (p.data!.length === 1 ? driverA : driverB),
  });

  await t.throwsAsync(() =>
    runExternalStore({ externalStorage, payloads: [makePayload(1), makePayload(2)] })
  );
  t.true(driverBAborted);
});

test('store/retrieve round-trip preserves order across drivers', async (t) => {
  const driverA = makeFakeDriver({ name: 'a' });
  const driverB = makeFakeDriver({ name: 'b' });
  const externalStorage = new ExternalStorage({
    drivers: [driverA, driverB],
    payloadSizeThreshold: 0,
    driverSelector: (_, p) => (p.data!.length % 2 === 0 ? driverA : driverB),
  });

  const inputPayloads = [makePayload(2), makePayload(3), makePayload(4), makePayload(5)];
  const storedPayloads = await runExternalStore({ externalStorage, payloads: inputPayloads });
  t.true(storedPayloads.every(isReferencePayload));

  const retrievedPayloads = await runExternalRetrieve({ externalStorage, payloads: storedPayloads });
  t.deepEqual(retrievedPayloads, inputPayloads);
});

test('runExternalRetrieve raises TMPRL1105 when a reference is found and externalStorage is undefined', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const storedPayloads = await runExternalStore({ externalStorage, payloads: [makePayload(1)] });

  await t.throwsAsync(() => runExternalRetrieve({ externalStorage: undefined, payloads: storedPayloads }), {
    instanceOf: ExternalStorageNotConfiguredError,
    message: /TMPRL1105/,
  });
});

test('runExternalRetrieve raises TMPRL1106 when the driver name is unknown', async (t) => {
  const writerDriver = makeFakeDriver({ name: 'writer' });
  const writerStorage = new ExternalStorage({ drivers: [writerDriver], payloadSizeThreshold: 0 });
  const storedPayloads = await runExternalStore({ externalStorage: writerStorage, payloads: [makePayload(1)] });

  const readerDriver = makeFakeDriver({ name: 'different-name' });
  const readerStorage = new ExternalStorage({ drivers: [readerDriver] });

  await t.throwsAsync(() => runExternalRetrieve({ externalStorage: readerStorage, payloads: storedPayloads }), {
    instanceOf: ExternalStorageDriverNotFoundError,
    message: /TMPRL1106/,
  });
});

test('runExternalRetrieve raises TMPRL1110 when retrieved bytes do not match the recorded size', async (t) => {
  const driver = makeFakeDriver({
    name: 's3',
    onRetrieve: () => [makePayload(999)], // wrong size
  });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const storedPayloads = await runExternalStore({ externalStorage, payloads: [makePayload(1)] });

  await t.throwsAsync(() => runExternalRetrieve({ externalStorage, payloads: storedPayloads }), {
    instanceOf: ExternalStorageIntegrityCheckFailedError,
    message: /TMPRL1110/,
  });
});

