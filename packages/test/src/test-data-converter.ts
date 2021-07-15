/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { ValueError, METADATA_ENCODING_KEY, encodingKeys, u8 } from '@temporalio/workflow/lib/converter/types';
import {
  UndefinedPayloadConverter,
  BinaryPayloadConverter,
  JsonPayloadConverter,
} from '@temporalio/workflow/lib/converter/payload-converter';
import { defaultDataConverter } from '@temporalio/workflow/lib/converter/data-converter';

test('UndefinedPayloadConverter converts from undefined only', async (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(await converter.toData(null), undefined);
  t.is(await converter.toData({}), undefined);
  t.is(await converter.toData(1), undefined);
  t.is(await converter.toData(0), undefined);
  t.is(await converter.toData('abc'), undefined);
  t.deepEqual(await converter.toData(undefined), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL },
  });
});

test('UndefinedPayloadConverter converts to undefined', async (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(await converter.fromData((await converter.toData(undefined))!), undefined);
});

test('BinaryPayloadConverter converts from Uint8Array', async (t) => {
  const converter = new BinaryPayloadConverter();
  t.is(await converter.toData(null), undefined);
  t.is(await converter.toData({}), undefined);
  t.is(await converter.toData(1), undefined);
  t.is(await converter.toData(0), undefined);
  t.is(await converter.toData('abc'), undefined);
  t.deepEqual(await converter.toData(u8('abc')), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
    data: u8('abc'),
  });
});

test('BinaryPayloadConverter converts to Uint8Array', async (t) => {
  const converter = new BinaryPayloadConverter();
  t.deepEqual(await converter.fromData((await converter.toData(u8('abc')))!), u8('abc'));
});

test('JsonPayloadConverter converts from non undefined', async (t) => {
  const payload = (val: any) => ({
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON },
    data: u8(JSON.stringify(val)),
  });
  const converter = new JsonPayloadConverter();
  t.deepEqual(await converter.toData(null), payload(null));
  t.deepEqual(await converter.toData({ a: 1 }), payload({ a: 1 }));
  t.deepEqual(await converter.toData(1), payload(1));
  t.deepEqual(await converter.toData(0), payload(0));
  t.deepEqual(await converter.toData('abc'), payload('abc'));
  t.is(await converter.toData(undefined), undefined);
});

test('JsonPayloadConverter converts to object', async (t) => {
  const converter = new JsonPayloadConverter();
  t.deepEqual(await converter.fromData((await converter.toData({ a: 1 }))!), { a: 1 });
});

test('defaultDataConverter converts to payload by trying each converter in order', async (t) => {
  t.deepEqual(await defaultDataConverter.toPayload('abc'), await new JsonPayloadConverter().toData('abc'));
  t.deepEqual(await defaultDataConverter.toPayload(undefined), await new UndefinedPayloadConverter().toData(undefined));
  t.deepEqual(await defaultDataConverter.toPayload(u8('abc')), await new BinaryPayloadConverter().toData(u8('abc')));
  // TODO: test non-jsonable value
});

test('defaultDataConverter converts from payload by payload type', async (t) => {
  t.deepEqual(await defaultDataConverter.fromPayload((await new JsonPayloadConverter().toData('abc'))!), 'abc');
  t.deepEqual(
    await defaultDataConverter.fromPayload((await new UndefinedPayloadConverter().toData(undefined))!),
    undefined
  );
  t.deepEqual(
    await defaultDataConverter.fromPayload((await new BinaryPayloadConverter().toData(u8('abc')))!),
    u8('abc')
  );
  await t.throwsAsync(
    async () => await defaultDataConverter.fromPayload({ metadata: { [METADATA_ENCODING_KEY]: u8('not-supported') } }),
    { instanceOf: ValueError, message: 'Unknown encoding: not-supported' }
  );
});
