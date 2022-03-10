/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { Connection, WorkflowClient } from '@temporalio/client';
import {
  BinaryPayloadConverter,
  defaultPayloadConverter,
  JsonPayloadConverter,
  PayloadConverterError,
  UndefinedPayloadConverter,
  UnsupportedJsonTypeError,
  ValueError,
} from '@temporalio/common';
import {
  encodingKeys,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  u8,
} from '@temporalio/common/lib/converter/types';
import {
  DefaultPayloadConverterWithProtobufs,
  ProtobufBinaryPayloadConverter,
  ProtobufJsonPayloadConverter,
} from '@temporalio/common/lib/protobufs';
import { Core, DefaultLogger, Worker } from '@temporalio/worker';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import root from '../protos/root';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { messageInstance } from './payload-converters/payload-converter';
import { protobufWorkflow } from './workflows';

test('UndefinedPayloadConverter converts from undefined only', async (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(await converter.toPayload(null), undefined);
  t.is(await converter.toPayload({}), undefined);
  t.is(await converter.toPayload(1), undefined);
  t.is(await converter.toPayload(0), undefined);
  t.is(await converter.toPayload('abc'), undefined);

  t.deepEqual(await converter.toPayload(undefined), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL },
  });
});

test('UndefinedPayloadConverter converts to undefined', async (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(await converter.fromPayload((await converter.toPayload(undefined))!), undefined);
});

test('BinaryPayloadConverter converts from Uint8Array', async (t) => {
  const converter = new BinaryPayloadConverter();
  t.is(await converter.toPayload(null), undefined);
  t.is(await converter.toPayload({}), undefined);
  t.is(await converter.toPayload(1), undefined);
  t.is(await converter.toPayload(0), undefined);
  t.is(await converter.toPayload('abc'), undefined);

  t.deepEqual(await converter.toPayload(u8('abc')), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
    data: u8('abc'),
  });
});

test('BinaryPayloadConverter converts to Uint8Array', async (t) => {
  const converter = new BinaryPayloadConverter();
  t.deepEqual(await converter.fromPayload((await converter.toPayload(u8('abc')))!), u8('abc'));
});

test('JsonPayloadConverter converts from non undefined', async (t) => {
  const payload = (val: any) => ({
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON },
    data: u8(JSON.stringify(val)),
  });
  const converter = new JsonPayloadConverter();
  t.deepEqual(await converter.toPayload(null), payload(null));
  t.deepEqual(await converter.toPayload({ a: 1 }), payload({ a: 1 }));
  t.deepEqual(await converter.toPayload(1), payload(1));
  t.deepEqual(await converter.toPayload(0), payload(0));
  t.deepEqual(await converter.toPayload('abc'), payload('abc'));

  t.is(await converter.toPayload(undefined), undefined);
  await t.throwsAsync(async () => await converter.toPayload(0n), {
    instanceOf: UnsupportedJsonTypeError,
    message: /Can't run JSON.stringify/,
  });
});

test('JsonPayloadConverter converts to object', async (t) => {
  const converter = new JsonPayloadConverter();
  t.deepEqual(await converter.fromPayload((await converter.toPayload({ a: 1 }))!), { a: 1 });
});

test('ProtobufBinaryPayloadConverter converts from an instance', async (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);
  t.deepEqual(await converter.toPayload(instance), {
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
  const testInstance = await converter.fromPayload((await converter.toPayload(instance))!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufBinaryPayloadConverter throws detailed errors', async (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);

  await t.throwsAsync(
    async () =>
      await converter.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
        data: root.ProtoActivityInput.encode(instance).finish(),
      }),
    { instanceOf: ValueError, message: 'Got protobuf payload without metadata.messageType' }
  );
  await t.throwsAsync(
    async () =>
      await converter.fromPayload({
        metadata: {
          [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
          [METADATA_MESSAGE_TYPE_KEY]: u8('NonExistentMessageClass'),
        },
        data: root.ProtoActivityInput.encode(instance).finish(),
      }),
    {
      instanceOf: PayloadConverterError,
      message: 'Got a `NonExistentMessageClass` protobuf message but cannot find corresponding message class in `root`',
    }
  );
});

test('ProtobufJSONPayloadConverter converts from an instance to JSON', async (t) => {
  const instance = root.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJsonPayloadConverter(root);
  t.deepEqual(await converter.toPayload(instance), {
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
  const testInstance = await converter.fromPayload((await converter.toPayload(instance))!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufJSONPayloadConverter converts binary', async (t) => {
  // binary should be base64-encoded:
  // https://developers.google.com/protocol-buffers/docs/proto3#json
  const instance = root.BinaryMessage.create({ data: u8('abc') });
  const converter = new ProtobufJsonPayloadConverter(root);
  const encoded = await converter.toPayload(instance);
  t.deepEqual(encoded, {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: u8('BinaryMessage'),
    },
    data: u8(JSON.stringify({ data: Buffer.from('abc').toString('base64') })),
  });

  const testInstance = await converter.fromPayload<root.BinaryMessage>(encoded!);
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
      if (entry.meta?.error.stack.includes('ValueError: Unknown encoding: json/protobuf')) {
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
      dataConverter: { payloadConverterPath: require.resolve('./payload-converters/payload-converter') },
    });
    const runPromise = worker.run();
    client.execute(protobufWorkflow, {
      args: [messageInstance],
      workflowId: uuid4(),
      taskQueue,
    });
    await expectedErrorWasThrown;
    t.pass();
    worker.shutdown();
    await runPromise;
  });
}

test('DefaultPayloadConverter converts protobufs', (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const defaultPayloadConverterWithProtos = new DefaultPayloadConverterWithProtobufs({ protobufRoot: root });
  t.deepEqual(
    defaultPayloadConverterWithProtos.toPayload(instance),
    // It will always use JSON because it appears before binary in the list
    new ProtobufJsonPayloadConverter(root).toPayload(instance)
  );
});

test('DefaultPayloadConverter converts to payload by trying each converter in order', async (t) => {
  const defaultPayloadConverterWithProtos = new DefaultPayloadConverterWithProtobufs({ protobufRoot: root });
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  t.deepEqual(
    defaultPayloadConverterWithProtos.toPayload(instance),
    new ProtobufJsonPayloadConverter().toPayload(instance)
  );

  t.deepEqual(defaultPayloadConverterWithProtos.toPayload('abc'), new JsonPayloadConverter().toPayload('abc'));
  t.deepEqual(
    defaultPayloadConverterWithProtos.toPayload(undefined),
    new UndefinedPayloadConverter().toPayload(undefined)
  );
  t.deepEqual(
    defaultPayloadConverterWithProtos.toPayload(u8('abc')),
    new BinaryPayloadConverter().toPayload(u8('abc'))
  );
  await t.throwsAsync(async () => defaultPayloadConverterWithProtos.toPayload(0n), {
    instanceOf: UnsupportedJsonTypeError,
  });
});

test('defaultPayloadConverter converts from payload by payload type', async (t) => {
  t.deepEqual(defaultPayloadConverter.fromPayload(new JsonPayloadConverter().toPayload('abc')!), 'abc');
  t.deepEqual(defaultPayloadConverter.fromPayload(new UndefinedPayloadConverter().toPayload(undefined)!), undefined);
  t.deepEqual(defaultPayloadConverter.fromPayload(new BinaryPayloadConverter().toPayload(u8('abc'))!), u8('abc'));
  await t.throwsAsync(
    async () => defaultPayloadConverter.fromPayload({ metadata: { [METADATA_ENCODING_KEY]: u8('not-supported') } }),
    { instanceOf: ValueError, message: 'Unknown encoding: not-supported' }
  );
  await t.throwsAsync(
    async () =>
      defaultPayloadConverter.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON },
      }),
    { instanceOf: ValueError, message: 'Got payload with no data' }
  );

  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const protoError = {
    instanceOf: ValueError,
    message: /Unknown encoding: .*protobuf/,
  };
  await t.throwsAsync(
    async () => defaultPayloadConverter.fromPayload(new ProtobufBinaryPayloadConverter(root).toPayload(instance)!),
    protoError
  );
  await t.throwsAsync(
    async () => defaultPayloadConverter.fromPayload(new ProtobufJsonPayloadConverter(root).toPayload(instance)!),
    protoError
  );
});
