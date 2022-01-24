/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { Connection, WorkflowClient } from '@temporalio/client';
import { DataConverterError, defaultPayloadConverter, DefaultPayloadConverter, ValueError } from '@temporalio/common';
import { Core, DefaultLogger, Worker } from '@temporalio/worker';
import { CompositeDataConverter } from '@temporalio/workflow-common';
import {
  BinaryPayloadConverter,
  JsonPayloadConverter,
  ProtobufBinaryPayloadConverter,
  ProtobufJsonPayloadConverter,
  UndefinedPayloadConverter,
} from '@temporalio/workflow-common/lib/converter/payload-converter';
import {
  encodingKeys,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  u8,
} from '@temporalio/workflow-common/lib/converter/types';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import root from '../protos/root';
import { messageInstance } from './payload-converters/payload-converter';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { protobufWorkflow } from './workflows';

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
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);
  t.deepEqual(await converter.toData(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
      [METADATA_MESSAGE_TYPE_KEY]: u8('ProtoActivityInput'),
    },
    data: root.ProtoActivityInput.encode(instance).finish(),
  });
});

test('ProtobufBinaryPayloadConverter converts to an instance', async (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);
  const testInstance = await converter.fromData((await converter.toData(instance))!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufBinaryPayloadConverter throws detailed errors', async (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);

  await t.throwsAsync(
    async () =>
      await converter.fromData({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
        data: root.ProtoActivityInput.encode(instance).finish(),
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
        data: root.ProtoActivityInput.encode(instance).finish(),
      }),
    {
      instanceOf: DataConverterError,
      message: 'Got a `NonExistentMessageClass` protobuf message but cannot find corresponding message class in `root`',
    }
  );
});

test('ProtobufJSONPayloadConverter converts from an instance to JSON', async (t) => {
  const instance = root.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJsonPayloadConverter(root);
  t.deepEqual(await converter.toData(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: u8('foo.bar.ProtoActivityInput'),
    },
    data: u8(JSON.stringify(instance)),
  });
});

test('ProtobufJSONPayloadConverter converts to an instance from JSON', async (t) => {
  const instance = root.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJsonPayloadConverter(root);
  const testInstance = await converter.fromData((await converter.toData(instance))!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufJSONPayloadConverter converts binary', async (t) => {
  // binary should be base64-encoded:
  // https://developers.google.com/protocol-buffers/docs/proto3#json
  const instance = root.BinaryMessage.create({ data: u8('abc') });
  const converter = new ProtobufJsonPayloadConverter(root);
  const encoded = await converter.toData(instance);
  t.deepEqual(encoded, {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: u8('BinaryMessage'),
    },
    data: u8(JSON.stringify({ data: Buffer.from('abc').toString('base64') })),
  });

  const testInstance = await converter.fromData<root.BinaryMessage>(encoded!);
  t.deepEqual(testInstance.data, Buffer.from(instance.data));
});

if (RUN_INTEGRATION_TESTS) {
  test('Worker throws decoding proto JSON without WorkerOptions.dataConverter', async (t) => {
    t.timeout(5 * 1000);
    let markErrorThrown: any;
    const expectedErrorWasThrown = new Promise(function (resolve) {
      markErrorThrown = resolve;
    });
    const logger = new DefaultLogger('ERROR', (entry) => {
      if (
        entry.meta?.error.stack.includes(
          'DataConverterError: Unable to deserialize protobuf message without `root` being provided'
        )
      ) {
        markErrorThrown();
      }
    });
    await Core.install({ logger });

    const taskQueue = 'test-data-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      enableSDKTracing: true,
    });
    const connection = new Connection();
    const client = new WorkflowClient(connection.service, {
      dataConverter: new CompositeDataConverter(new ProtobufJsonPayloadConverter(root)),
    });
    worker.run();
    client.execute(protobufWorkflow, {
      args: [messageInstance],
      workflowId: uuid4(),
      taskQueue,
    });
    await expectedErrorWasThrown;
    t.pass();
    worker.shutdown();
  });
}

test('DefaultPayloadConverter converts protobufs', async (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const defaultPayloadConverterWithProtos = new DefaultPayloadConverter({ root });
  t.deepEqual(
    defaultPayloadConverterWithProtos.toPayload(instance),
    // It will always use JSON because it appears before binary in the list
    await new ProtobufJsonPayloadConverter(root).toData(instance)
  );
});

test('defaultPayloadConverter converts to payload by trying each converter in order', async (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  t.deepEqual(defaultPayloadConverter.toPayload(instance), await new ProtobufJsonPayloadConverter().toData(instance));

  t.deepEqual(defaultPayloadConverter.toPayload('abc'), await new JsonPayloadConverter().toData('abc'));
  t.deepEqual(defaultPayloadConverter.toPayload(undefined), await new UndefinedPayloadConverter().toData(undefined));
  t.deepEqual(defaultPayloadConverter.toPayload(u8('abc')), await new BinaryPayloadConverter().toData(u8('abc')));
  await t.throws(() => defaultPayloadConverter.toPayload(0n), {
    instanceOf: TypeError,
    message: 'Do not know how to serialize a BigInt',
  });
});

test('defaultPayloadConverter converts from payload by payload type', async (t) => {
  t.deepEqual(defaultPayloadConverter.fromPayload(new JsonPayloadConverter().toData('abc')!), 'abc');
  t.deepEqual(defaultPayloadConverter.fromPayload(new UndefinedPayloadConverter().toData(undefined)!), undefined);
  t.deepEqual(defaultPayloadConverter.fromPayload(new BinaryPayloadConverter().toData(u8('abc'))!), u8('abc'));
  await t.throwsAsync(
    async () => defaultPayloadConverter.fromPayload({ metadata: { [METADATA_ENCODING_KEY]: u8('not-supported') } }),
    { instanceOf: ValueError, message: 'Unknown encoding: not-supported' }
  );
  await t.throwsAsync(
    async () =>
      defaultPayloadConverter.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
      }),
    { instanceOf: ValueError, message: 'Got payload with no data' }
  );

  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const protoError = {
    instanceOf: DataConverterError,
    message: 'Unable to deserialize protobuf message without `root` being provided',
  };
  await t.throwsAsync(
    async () => defaultPayloadConverter.fromPayload(new ProtobufBinaryPayloadConverter(root).toData(instance)!),
    protoError
  );
  await t.throwsAsync(
    async () => defaultPayloadConverter.fromPayload(new ProtobufJsonPayloadConverter(root).toData(instance)!),
    protoError
  );
});
