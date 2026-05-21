/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import {
  ApplicationFailure,
  defaultPayloadConverter,
  ExternalStorage,
  ExternalStorageNotConfiguredError,
  defaultFailureConverter,
  type LoadedDataConverter,
  type WorkflowSerializationContext,
} from '@temporalio/common';
import {
  decodeArrayFromPayloads,
  decodeOptionalFailureToOptionalError,
  encodeErrorToFailure,
  encodeToPayloads,
  encodeToPayloadsWithContext,
  isLoadedDataConverter,
  loadDataConverter,
} from '@temporalio/common/lib/internal-non-workflow';
import { makeFakeDriver } from './extstore-fake-driver';

function makeConverter(externalStorage?: ExternalStorage): LoadedDataConverter {
  const loaded = loadDataConverter({ externalStorage });
  if (!isLoadedDataConverter(loaded)) throw new Error('unreachable');
  return loaded;
}

test('encodeToPayloadsWithContext threads identity into StorageDriverStoreContext.target', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const converter = makeConverter(externalStorage);
  const context: WorkflowSerializationContext = {
    type: 'workflow',
    namespace: 'ns',
    workflowId: 'wf-1',
  };

  const payloads = await encodeToPayloadsWithContext(converter, context, ['hello', { v: 42 }]);
  t.is(payloads!.length, 2);
  t.is(driver.storeCalls.length, 1);
  t.deepEqual(driver.storeCalls[0]!.context.target, context);

  const decoded = await decodeArrayFromPayloads(converter, payloads!);
  t.deepEqual(decoded, ['hello', { v: 42 }]);
});

test('encodeToPayloads is a no-op when externalStorage is undefined', async (t) => {
  const converter = makeConverter(undefined);
  const payloads = await encodeToPayloads(converter, 'hello');
  // Plain JSON payload — not a reference.
  t.is(payloads!.length, 1);
  t.falsy(payloads![0]!.externalPayloads?.length);
});

test('decodeArrayFromPayloads raises TMPRL1105 when no externalStorage and reference payload received', async (t) => {
  const driver = makeFakeDriver();
  const writerStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const writerConv = makeConverter(writerStorage);
  const storedPayloads = await encodeToPayloads(writerConv, 'big');

  const readerConv = makeConverter(undefined);
  await t.throwsAsync(() => decodeArrayFromPayloads(readerConv, storedPayloads!), {
    instanceOf: ExternalStorageNotConfiguredError,
    message: /TMPRL1105/,
  });
});

test('encodeErrorToFailure offloads oversized application failure details', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const converter = makeConverter(externalStorage);
  const context: WorkflowSerializationContext = {
    type: 'workflow',
    namespace: 'ns',
    workflowId: 'wf-1',
  };

  const bigPayload = { blob: 'x'.repeat(1024) };
  const failure = await encodeErrorToFailure(
    converter,
    ApplicationFailure.create({ message: 'boom', details: [bigPayload] }),
    context
  );

  const details = failure.applicationFailureInfo?.details?.payloads ?? [];
  t.is(details.length, 1);
  t.truthy(details[0]!.externalPayloads?.length);

  const error = await decodeOptionalFailureToOptionalError(converter, failure, context);
  t.true(error instanceof ApplicationFailure);
  t.deepEqual((error as ApplicationFailure).details, [bigPayload]);
});

// Ensure we don't accidentally regress the default loaded converter when
// externalStorage isn't passed.
test('loadDataConverter passes through externalStorage when set', (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver] });
  const loaded = loadDataConverter({ externalStorage });
  t.is(loaded.externalStorage, externalStorage);
});

// Silence the unused-imports warning for converter types we keep around
// for clarity in this file's signatures.
void defaultPayloadConverter;
void defaultFailureConverter;
