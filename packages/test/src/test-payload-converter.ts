/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { WorkflowClient, WorkflowHandle } from '@temporalio/client';
import {
  BinaryPayloadConverter,
  defaultPayloadConverter,
  JsonPayloadConverter,
  PayloadConverterError,
  UndefinedPayloadConverter,
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
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import root from '../protos/root';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { messageInstance } from './payload-converters/proto-payload-converter';
import { protobufWorkflow } from './workflows/protobufs';

test('UndefinedPayloadConverter converts from undefined only', (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(converter.toPayload(null), undefined);
  t.is(converter.toPayload({}), undefined);
  t.is(converter.toPayload(1), undefined);
  t.is(converter.toPayload(0), undefined);
  t.is(converter.toPayload('abc'), undefined);

  t.deepEqual(converter.toPayload(undefined), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL },
  });
});

test('UndefinedPayloadConverter converts to undefined', (t) => {
  const converter = new UndefinedPayloadConverter();
  t.is(converter.fromPayload(converter.toPayload(undefined)!), undefined);
});

test('BinaryPayloadConverter converts from Uint8Array', (t) => {
  const converter = new BinaryPayloadConverter();
  t.is(converter.toPayload(null), undefined);
  t.is(converter.toPayload({}), undefined);
  t.is(converter.toPayload(1), undefined);
  t.is(converter.toPayload(0), undefined);
  t.is(converter.toPayload('abc'), undefined);

  t.deepEqual(converter.toPayload(u8('abc')), {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
    data: u8('abc'),
  });
});

test('BinaryPayloadConverter converts to Uint8Array', (t) => {
  const converter = new BinaryPayloadConverter();
  t.deepEqual(converter.fromPayload(converter.toPayload(u8('abc'))!), u8('abc'));
});

test('JsonPayloadConverter converts from non undefined', (t) => {
  const payload = (val: any) => ({
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON },
    data: u8(JSON.stringify(val)),
  });
  const converter = new JsonPayloadConverter();
  t.deepEqual(converter.toPayload(null), payload(null));
  t.deepEqual(converter.toPayload({ a: 1 }), payload({ a: 1 }));
  t.deepEqual(converter.toPayload(1), payload(1));
  t.deepEqual(converter.toPayload(0), payload(0));
  t.deepEqual(converter.toPayload('abc'), payload('abc'));

  t.is(converter.toPayload(undefined), undefined);
  t.is(converter.toPayload(0n), undefined);
});

test('JsonPayloadConverter converts to object', (t) => {
  const converter = new JsonPayloadConverter();
  t.deepEqual(converter.fromPayload(converter.toPayload({ a: 1 })!), { a: 1 });
});

test('ProtobufBinaryPayloadConverter converts from an instance', (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);
  t.deepEqual(converter.toPayload(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
      [METADATA_MESSAGE_TYPE_KEY]: u8('ProtoActivityInput'),
    },
    data: root.ProtoActivityInput.encode(instance).finish(),
  });
});

test('ProtobufBinaryPayloadConverter converts to an instance', (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);
  const testInstance = converter.fromPayload(converter.toPayload(instance)!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufBinaryPayloadConverter throws detailed errors', (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufBinaryPayloadConverter(root);

  t.throws(
    () =>
      converter.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
        data: root.ProtoActivityInput.encode(instance).finish(),
      }),
    { instanceOf: ValueError, message: 'Got protobuf payload without metadata.messageType' }
  );
  t.throws(
    () =>
      converter.fromPayload({
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

test('ProtobufJSONPayloadConverter converts from an instance to JSON', (t) => {
  const instance = root.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJsonPayloadConverter(root);
  t.deepEqual(converter.toPayload(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: u8('foo.bar.ProtoActivityInput'),
    },
    data: u8(JSON.stringify(instance)),
  });
});

test('ProtobufJSONPayloadConverter converts to an instance from JSON', (t) => {
  const instance = root.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const converter = new ProtobufJsonPayloadConverter(root);
  const testInstance = converter.fromPayload(converter.toPayload(instance)!);
  // tests that both are instances of the same class with the same properties
  t.deepEqual(testInstance, instance);
});

test('ProtobufJSONPayloadConverter converts binary', (t) => {
  // binary should be base64-encoded:
  // https://developers.google.com/protocol-buffers/docs/proto3#json
  const instance = root.BinaryMessage.create({ data: u8('abc') });
  const converter = new ProtobufJsonPayloadConverter(root);
  const encoded = converter.toPayload(instance);
  t.deepEqual(encoded, {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: u8('BinaryMessage'),
    },
    data: u8(JSON.stringify({ data: Buffer.from('abc').toString('base64') })),
  });

  const testInstance = converter.fromPayload<root.BinaryMessage>(encoded!);
  t.deepEqual(testInstance.data, Buffer.from(instance.data));
});

if (RUN_INTEGRATION_TESTS) {
  test('Worker throws decoding proto JSON without WorkerOptions.dataConverter', async (t) => {
    let markErrorThrown: () => void;
    const expectedErrorWasThrown = new Promise<void>((resolve) => {
      markErrorThrown = resolve;
    });
    const logger = new DefaultLogger('ERROR', (entry) => {
      if (entry.meta?.error.stack.startsWith('ValueError: Unknown encoding: json/protobuf')) {
        markErrorThrown();
      }
    });
    Runtime.install({ logger });

    const taskQueue = 'test-data-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      workflowsPath: require.resolve('./workflows/protobufs'),
      taskQueue,
    });
    const client = await WorkflowClient.forLocalServer({
      dataConverter: { payloadConverterPath: require.resolve('./payload-converters/proto-payload-converter') },
    });

    const handle = await client.start(protobufWorkflow, {
      args: [messageInstance],
      workflowId: uuid4(),
      taskQueue,
    });

    await Promise.all([
      worker.run(),
      (async () => {
        try {
          await expectedErrorWasThrown;
        } finally {
          await handle.terminate();
          worker.shutdown();
        }
      })(),
    ]);
    t.pass();
  });
}

test('DefaultPayloadConverterWithProtobufs converts protobufs', (t) => {
  const instance = root.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const defaultPayloadConverterWithProtos = new DefaultPayloadConverterWithProtobufs({ protobufRoot: root });
  t.deepEqual(
    defaultPayloadConverterWithProtos.toPayload(instance),
    // It will always use JSON because it appears before binary in the list
    new ProtobufJsonPayloadConverter(root).toPayload(instance)
  );
});

test('DefaultPayloadConverterWithProtobufs converts to payload by trying each converter in order', (t) => {
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
  t.throws(() => defaultPayloadConverterWithProtos.toPayload(0n), { instanceOf: ValueError });
});

test('defaultPayloadConverter converts from payload by payload type', (t) => {
  t.deepEqual(defaultPayloadConverter.fromPayload(new JsonPayloadConverter().toPayload('abc')!), 'abc');
  t.deepEqual(defaultPayloadConverter.fromPayload(new UndefinedPayloadConverter().toPayload(undefined)!), undefined);
  t.deepEqual(defaultPayloadConverter.fromPayload(new BinaryPayloadConverter().toPayload(u8('abc'))!), u8('abc'));
  t.throws(() => defaultPayloadConverter.fromPayload({ metadata: { [METADATA_ENCODING_KEY]: u8('not-supported') } }), {
    instanceOf: ValueError,
    message: 'Unknown encoding: not-supported',
  });
  t.throws(
    () =>
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
  t.throws(
    () => defaultPayloadConverter.fromPayload(new ProtobufBinaryPayloadConverter(root).toPayload(instance)!),
    protoError
  );
  t.throws(
    () => defaultPayloadConverter.fromPayload(new ProtobufJsonPayloadConverter(root).toPayload(instance)!),
    protoError
  );
});
