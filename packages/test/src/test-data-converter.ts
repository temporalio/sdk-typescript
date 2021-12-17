/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { defaultDataConverter, ValueError, DataConverterError, DefaultDataConverter } from '@temporalio/common';
import {
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  encodingKeys,
  u8,
} from '@temporalio/common/lib/converter/types';
import {
  UndefinedPayloadConverter,
  BinaryPayloadConverter,
  JsonPayloadConverter,
  ProtobufBinaryPayloadConverter,
  ProtobufJSONPayloadConverter,
} from '@temporalio/common/lib/converter/payload-converter';
import protobufClasses from '../protos/protobufs';

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

test('ProtobufBinaryPayloadConverter converts from an instance', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(protobufClasses);
  t.deepEqual(await converter.toData(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
      [METADATA_MESSAGE_TYPE_KEY]: u8('ProtoActivityInput'),
    },
    data: protobufClasses.ProtoActivityInput.encode(instance).finish(),
  });
});

test('ProtobufBinaryPayloadConverter converts to an instance', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(protobufClasses);
  const testInstance = await converter.fromData((await converter.toData(instance))!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufBinaryPayloadConverter throws detailed errors', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(protobufClasses);

  await t.throwsAsync(
    async () =>
      await converter.fromData({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
        data: protobufClasses.ProtoActivityInput.encode(instance).finish(),
      }),
    { instanceOf: ValueError, message: 'Got protobuf payload without metadata.messageType' }
  );
  await t.throwsAsync(
    async () =>
      await converter.fromData({
        metadata: {
          [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
          [METADATA_MESSAGE_TYPE_KEY]: u8('NonExistentMessageClass'),
        },
        data: protobufClasses.ProtoActivityInput.encode(instance).finish(),
      }),
    {
      instanceOf: DataConverterError,
      message:
        'Got a `NonExistentMessageClass` protobuf message but cannot find corresponding message class in protobufClasses',
    }
  );
});

test('ProtobufJSONPayloadConverter converts from an instance to JSON', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJSONPayloadConverter(protobufClasses);
  t.deepEqual(await converter.toData(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: u8('ProtoActivityInput'),
    },
    data: u8(JSON.stringify(instance)),
  });
});

test('ProtobufJSONPayloadConverter converts to an instance from JSON', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJSONPayloadConverter(protobufClasses);
  const testInstance = await converter.fromData((await converter.toData(instance))!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('DefaultDataConverter converts protobufs', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const defaultDataConverterWithProtos = new DefaultDataConverter({ protobufClasses });
  t.deepEqual(
    await defaultDataConverterWithProtos.toPayload(instance),
    // It will always use JSON because it appears before binary in the list
    await new ProtobufJSONPayloadConverter(protobufClasses).toData(instance)
  );
});

test('defaultDataConverter converts to payload by trying each converter in order', async (t) => {
  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  // defaultDataConverter shouldn't use Protobuf*PayloadConverter without protobufClasses,
  // so it should fall through to JsonPayloadConverter
  t.deepEqual(await defaultDataConverter.toPayload(instance), await new JsonPayloadConverter().toData(instance));

  t.deepEqual(await defaultDataConverter.toPayload('abc'), await new JsonPayloadConverter().toData('abc'));
  t.deepEqual(await defaultDataConverter.toPayload(undefined), await new UndefinedPayloadConverter().toData(undefined));
  t.deepEqual(await defaultDataConverter.toPayload(u8('abc')), await new BinaryPayloadConverter().toData(u8('abc')));
  await t.throwsAsync(async () => await defaultDataConverter.toPayload(0n), {
    instanceOf: TypeError,
    message: 'Do not know how to serialize a BigInt',
  });
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
  await t.throwsAsync(
    async () =>
      await defaultDataConverter.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
      }),
    { instanceOf: ValueError, message: 'Got payload with no data' }
  );

  const instance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const protoError = {
    instanceOf: DataConverterError,
    message: 'Unable to deserialize protobuf message without `protobufClasses` being provided',
  };
  await t.throwsAsync(
    async () =>
      await defaultDataConverter.fromPayload(
        (await new ProtobufBinaryPayloadConverter(protobufClasses).toData(instance))!
      ),
    protoError
  );
  await t.throwsAsync(
    async () =>
      await defaultDataConverter.fromPayload(
        (await new ProtobufJSONPayloadConverter(protobufClasses).toData(instance))!
      ),
    protoError
  );
});
