import test from 'ava';
import { ValueError, METADATA_ENCODING_KEY, encodingKeys, u8 } from '../../workflow-lib/commonjs/converter/types';
import {
  UndefinedPayloadConverter,
  BinaryPayloadConverter,
  JsonPayloadConverter,
} from '../../workflow-lib/commonjs/converter/payload-converter';
import { defaultDataConverter } from '../../workflow-lib/commonjs/converter/data-converter';

test('UndefinedPayloadConverter converts from undefined only', (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(converter.toData(null), undefined);
  t.is(converter.toData({}), undefined);
  t.is(converter.toData(1), undefined);
  t.is(converter.toData(0), undefined);
  t.is(converter.toData("abc"), undefined);
  t.deepEqual(converter.toData(undefined), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL },
  });
});

test('UndefinedPayloadConverter converts to undefined', (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(converter.fromData(converter.toData(undefined)!), undefined);
});

test('BinaryPayloadConverter converts from Uint8Array', (t) => {
  const converter = new BinaryPayloadConverter();
  t.is(converter.toData(null), undefined);
  t.is(converter.toData({}), undefined);
  t.is(converter.toData(1), undefined);
  t.is(converter.toData(0), undefined);
  t.is(converter.toData("abc"), undefined);
  t.deepEqual(converter.toData(u8("abc")), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
    data: u8("abc"),
  });
});

test('BinaryPayloadConverter converts to Uint8Array', (t) => {
  const converter = new BinaryPayloadConverter();
  t.deepEqual(converter.fromData(converter.toData(u8('abc'))!), u8('abc'));
});

test('JsonPayloadConverter converts from non undefined', (t) => {
  const payload = (val: any) => ({
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON },
    data: u8(JSON.stringify(val)),
  });
  const converter = new JsonPayloadConverter();
  t.deepEqual(converter.toData(null), payload(null));
  t.deepEqual(converter.toData({ a: 1 }), payload({ a: 1 }));
  t.deepEqual(converter.toData(1), payload(1));
  t.deepEqual(converter.toData(0), payload(0));
  t.deepEqual(converter.toData("abc"), payload("abc"));
  t.is(converter.toData(undefined), undefined);
});

test('JsonPayloadConverter converts to undefined', (t) => {
  const converter = new JsonPayloadConverter();
  t.deepEqual(converter.fromData(converter.toData({ a: 1 })!), { a: 1 });
});

test('defaultDataConverter converts to payload by trying each converter in order', (t) => {
  t.deepEqual(defaultDataConverter.toPayload("abc"), new JsonPayloadConverter().toData("abc"));
  t.deepEqual(defaultDataConverter.toPayload(undefined), new UndefinedPayloadConverter().toData(undefined));
  t.deepEqual(defaultDataConverter.toPayload(u8("abc")), new BinaryPayloadConverter().toData(u8("abc")));
  // TODO: test non-jsonable value
});

test('defaultDataConverter converts from payload by payload type', (t) => {
  t.deepEqual(defaultDataConverter.fromPayload(new JsonPayloadConverter().toData("abc")!), "abc");
  t.deepEqual(defaultDataConverter.fromPayload(new UndefinedPayloadConverter().toData(undefined)!), undefined);
  t.deepEqual(defaultDataConverter.fromPayload(new BinaryPayloadConverter().toData(u8("abc"))!), u8("abc"));
  const err = t.throws(
    () => defaultDataConverter.fromPayload({ metadata: { [METADATA_ENCODING_KEY]: u8('not-supported') } })
  );
  t.true(err instanceof ValueError);
  t.is(err.message, 'Unknown encoding: not-supported');
});
