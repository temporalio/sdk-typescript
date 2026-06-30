/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { ValueError, type Payload } from '@temporalio/common';
import { ExternalStorage } from '@temporalio/common/lib/converter/extstore';
import { ExternalStorageRunner, isReferencePayload } from '@temporalio/common/lib/internal-non-workflow';
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

test('store leaves payloads inline when below the threshold', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 }));
  const smallPayload = makePayload(8);

  const result = await runner.store([smallPayload]);

  t.is(driver.storeCalls.length, 0);
  t.deepEqual(result, [smallPayload]);
});

test('store offloads payloads above the threshold', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 32 }));
  const bigPayload = makePayload(128);

  const result = await runner.store([bigPayload]);

  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.payloads.length, 1);
  t.true(isReferencePayload(result[0]!));
});

test('store with payloadSizeThreshold=0 stores every payload', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 }));
  const tinyPayload = makePayload(0);

  const result = await runner.store([tinyPayload, tinyPayload]);

  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.payloads.length, 2);
  t.true(isReferencePayload(result[0]!));
  t.true(isReferencePayload(result[1]!));
});

// make sure store doesn't do unexpected batching or delayed delivery of payloads
test('store batches all payloads in a single store request', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 }));
  const payloadA = makePayload(2);
  const payloadB = makePayload(3);

  await runner.store([payloadA, payloadB]);
  t.is(driver.storeCalls.length, 1);
  await runner.store([payloadA]);
  await runner.store([payloadB]);
  t.is(driver.storeCalls.length, 3);
});

test('store selector routes to the chosen driver and groups by name', async (t) => {
  const driverA = makeFakeDriver({ name: 'a' });
  const driverB = makeFakeDriver({ name: 'b' });
  const runner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [driverA, driverB],
      payloadSizeThreshold: 0,
      driverSelector: (_, p) => (p.data!.length % 2 === 0 ? driverA : driverB),
    })
  );
  const evenPayloadA = makePayload(2);
  const oddPayload = makePayload(3);
  const evenPayloadB = makePayload(4);

  await runner.store([evenPayloadA, oddPayload, evenPayloadB]);

  t.is(driverA.storeCalls[0]!.payloads.length, 2); // evenPayloadA, evenPayloadB
  t.is(driverB.storeCalls[0]!.payloads.length, 1); // oddPayload
});

test('store selector returning null leaves the payload inline', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [driver],
      payloadSizeThreshold: 0,
      driverSelector: () => null,
    })
  );

  const originalPayload = makePayload(64);
  const result = await runner.store([originalPayload]);

  t.is(driver.storeCalls.length, 0);
  t.deepEqual(result, [originalPayload]);
});

test('store throws ValueError when selector returns an unregistered driver', async (t) => {
  const registeredDriver = makeFakeDriver({ name: 'a' });
  const strangerDriver = makeFakeDriver({ name: 'a' }); // same name, different identity
  const runner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [registeredDriver],
      payloadSizeThreshold: 0,
      driverSelector: () => strangerDriver,
    })
  );

  await t.throwsAsync(() => runner.store([makePayload(1)]), {
    instanceOf: ValueError,
  });
});

test('store propagates driver errors unchanged', async (t) => {
  const boom = new Error('disk full');
  const driver = makeFakeDriver({ name: 's3', onStore: () => Promise.reject(boom) });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 }));

  const err = await t.throwsAsync(() => runner.store([makePayload(1)]));
  t.is(err, boom);
});

test('store raises ValueError on claim arity mismatch', async (t) => {
  const driver = makeFakeDriver({ name: 's3', onStore: () => [] });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 }));

  await t.throwsAsync(() => runner.store([makePayload(1)]), {
    instanceOf: ValueError,
  });
});

test('store aborts sibling drivers on first failure', async (t) => {
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
  const runner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [driverA, driverB],
      payloadSizeThreshold: 0,
      driverSelector: (_ctx, p) => (p.data!.length === 1 ? driverA : driverB),
    })
  );

  await t.throwsAsync(() => runner.store([makePayload(1), makePayload(2)]));
  t.true(driverBAborted);
});

test('store/retrieve round-trip preserves order across drivers', async (t) => {
  const driverA = makeFakeDriver({ name: 'a' });
  const driverB = makeFakeDriver({ name: 'b' });
  const runner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [driverA, driverB],
      payloadSizeThreshold: 0,
      driverSelector: (_, p) => (p.data!.length % 2 === 0 ? driverA : driverB),
    })
  );

  const inputPayloads = [makePayload(2), makePayload(3), makePayload(4), makePayload(5)];
  const storedPayloads = await runner.store(inputPayloads);
  t.true(storedPayloads.every(isReferencePayload));

  const retrievedPayloads = await runner.retrieve(storedPayloads);
  t.deepEqual(retrievedPayloads, inputPayloads);
});

test('retrieve raises ValueError when the driver name is unknown', async (t) => {
  const writerDriver = makeFakeDriver({ name: 'writer' });
  const writerRunner = new ExternalStorageRunner(
    new ExternalStorage({ drivers: [writerDriver], payloadSizeThreshold: 0 })
  );
  const storedPayloads = await writerRunner.store([makePayload(1)]);

  const readerDriver = makeFakeDriver({ name: 'different-name' });
  const readerRunner = new ExternalStorageRunner(new ExternalStorage({ drivers: [readerDriver] }));

  await t.throwsAsync(() => readerRunner.retrieve(storedPayloads), {
    instanceOf: ValueError,
  });
});

test('retrieve raises ValueError on payload arity mismatch', async (t) => {
  const payloadsToStore = [makePayload(1), makePayload(2)];
  const payloadsToRetrieve = [makePayload(1)];

  const writerDriver = makeFakeDriver({ name: 's3' });
  const writerRunner = new ExternalStorageRunner(
    new ExternalStorage({ drivers: [writerDriver], payloadSizeThreshold: 0 })
  );
  const storedPayloads = await writerRunner.store(payloadsToStore);

  const readerDriver = makeFakeDriver({ name: 's3', onRetrieve: () => payloadsToRetrieve });
  const readerRunner = new ExternalStorageRunner(
    new ExternalStorage({ drivers: [readerDriver], payloadSizeThreshold: 0 })
  );

  await t.throwsAsync(() => readerRunner.retrieve(storedPayloads), {
    instanceOf: ValueError,
  });
});

test('retrieve propagates driver errors unchanged', async (t) => {
  const boom = new Error('object gone');
  const writerDriver = makeFakeDriver({ name: 's3' });
  const writerRunner = new ExternalStorageRunner(
    new ExternalStorage({ drivers: [writerDriver], payloadSizeThreshold: 0 })
  );
  const storedPayloads = await writerRunner.store([makePayload(1)]);

  const readerDriver = makeFakeDriver({ name: 's3', onRetrieve: () => Promise.reject(boom) });
  const readerRunner = new ExternalStorageRunner(
    new ExternalStorage({ drivers: [readerDriver], payloadSizeThreshold: 0 })
  );

  const err = await t.throwsAsync(() => readerRunner.retrieve(storedPayloads));
  t.is(err, boom);
});

test('retrieve only resolves reference payloads, passing others through', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 256 }));
  const inlineBefore = makePayload(8);
  const offloaded = makePayload(1024);
  const inlineAfter = makePayload(8);

  const storedPayloads = await runner.store([inlineBefore, offloaded, inlineAfter]);
  t.false(isReferencePayload(storedPayloads[0]!));
  t.true(isReferencePayload(storedPayloads[1]!));
  t.false(isReferencePayload(storedPayloads[2]!));

  const retrievedPayloads = await runner.retrieve(storedPayloads);
  t.deepEqual(retrievedPayloads, [inlineBefore, offloaded, inlineAfter]);
  t.is(driver.retrieveCalls.length, 1);
  t.is(driver.retrieveCalls[0]!.claims.length, 1);
});

test('retrieve returns payloads unchanged when none are references', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 }));
  const inlinePayloads = [makePayload(8), makePayload(16)];

  const result = await runner.retrieve(inlinePayloads);

  t.is(driver.retrieveCalls.length, 0);
  t.deepEqual(result, inlinePayloads);
});

test('retrieve batches multiple references to the same driver into one call', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const runner = new ExternalStorageRunner(new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 }));

  const storedPayloads = await runner.store([makePayload(1), makePayload(2), makePayload(3)]);
  t.true(storedPayloads.every(isReferencePayload));

  const retrievedPayloads = await runner.retrieve(storedPayloads);

  t.is(driver.retrieveCalls.length, 1);
  t.is(driver.retrieveCalls[0]!.claims.length, 3);
  t.is(retrievedPayloads.length, 3);
});

test('retrieve aborts sibling drivers on first failure', async (t) => {
  // Two drivers that store one payload each (succesfully)
  const writerA = makeFakeDriver({ name: 'a' });
  const writerB = makeFakeDriver({ name: 'b' });
  const writerRunner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [writerA, writerB],
      payloadSizeThreshold: 0,
      driverSelector: (_ctx, p) => (p.data!.length % 2 === 0 ? writerA : writerB),
    })
  );
  const storedPayloads = await writerRunner.store([makePayload(2), makePayload(3)]);

  // Attempt to retrieve payloads. Reader A fails on retrieve.
  // Reader B just "waits" until it sees abort event.
  let readerBAborted = false;
  const readerA = makeFakeDriver({ name: 'a', onRetrieve: () => Promise.reject(new Error('boom')) });
  const readerB = makeFakeDriver({
    name: 'b',
    onRetrieve: () =>
      new Promise((resolve, reject) => {
        const ctxAbort = readerB.retrieveCalls[readerB.retrieveCalls.length - 1]!.context.abortSignal!;
        ctxAbort.addEventListener('abort', () => {
          readerBAborted = true;
          reject(new Error('aborted'));
        });
        void resolve;
      }),
  });
  const readerRunner = new ExternalStorageRunner(
    new ExternalStorage({
      drivers: [readerA, readerB],
      payloadSizeThreshold: 0,
      driverSelector: () => readerA,
    })
  );

  await t.throwsAsync(() => readerRunner.retrieve(storedPayloads));
  t.true(readerBAborted);
});
