/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { create, createRegistry, toBinary, toJson } from '@bufbuild/protobuf';
import { anyPack, anyUnpack, AnySchema } from '@bufbuild/protobuf/wkt';
import { WorkflowClient } from '@temporalio/client';
import {
  BinaryPayloadConverter,
  defaultPayloadConverter,
  encodingKeys,
  JsonPayloadConverter,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  PayloadConverterError,
  UndefinedPayloadConverter,
  ValueError,
} from '@temporalio/common';
import { decode, encode } from '@temporalio/common/lib/encoding';
import { ProtobufBinaryPayloadConverter, ProtobufJsonPayloadConverter } from '@temporalio/common/lib/protobufs';
import {
  DefaultPayloadConverterWithProtobufsEs,
  ProtobufEsBinaryPayloadConverter,
  ProtobufEsJsonPayloadConverter,
} from '@temporalio/common/lib/protobufs-es';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import pbjsRoot from '../protos/root'; // eslint-disable-line import/default
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { echoBinaryProtobufEs } from './workflows/echo-binary-protobuf-es';
import { echoProtoEsInput } from './workflows/echo-protobuf-es-input';
import {
  finishSignal,
  getInputQuery,
  protobufEsSignalsQueriesUpdates,
  sentenceUpdate,
  setInputSignal,
} from './workflows/protobufs-es-signals-queries-updates';
import type { BinaryMessage as EsBinaryMessageType } from './protos-es-gen/messages_pb';
import {
  BinaryMessageSchema,
  Color,
  MapMessageSchema,
  NumbersAndEnumSchema,
  OneofMessageSchema,
  ProtoActivityInputSchema,
  WrapperSchema,
} from './protos-es-gen/messages_pb';
import { ProtoActivityInputSchema as NamespacedProtoActivityInputSchema } from './protos-es-gen/namespaced-messages_pb';

const registry = createRegistry(
  ProtoActivityInputSchema,
  BinaryMessageSchema,
  WrapperSchema,
  OneofMessageSchema,
  MapMessageSchema,
  NumbersAndEnumSchema,
  NamespacedProtoActivityInputSchema,
  AnySchema
);

test('ProtobufEsBinaryPayloadConverter converts from an instance', (t) => {
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const converter = new ProtobufEsBinaryPayloadConverter(registry);
  t.deepEqual(converter.toPayload(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
      [METADATA_MESSAGE_TYPE_KEY]: encode('ProtoActivityInput'),
    },
    data: toBinary(ProtoActivityInputSchema, instance),
  });
});

test('ProtobufEsBinaryPayloadConverter accepts a schema array in lieu of a registry', (t) => {
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const converter = new ProtobufEsBinaryPayloadConverter([ProtoActivityInputSchema]);
  const payload = converter.toPayload(instance);
  t.deepEqual(converter.fromPayload(payload!), instance);
});

test('ProtobufEsBinaryPayloadConverter round-trips an instance', (t) => {
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const converter = new ProtobufEsBinaryPayloadConverter(registry);
  const result = converter.fromPayload(converter.toPayload(instance)!);
  t.deepEqual(result, instance);
});

test('ProtobufEsBinaryPayloadConverter returns undefined for non-protobuf values', (t) => {
  const converter = new ProtobufEsBinaryPayloadConverter(registry);
  t.is(converter.toPayload(null), undefined);
  t.is(converter.toPayload({}), undefined);
  t.is(converter.toPayload({ $typeName: 1 }), undefined);
  t.is(converter.toPayload(1), undefined);
  t.is(converter.toPayload('abc'), undefined);
  t.is(converter.toPayload(encode('abc')), undefined);
});

test('ProtobufEsBinaryPayloadConverter throws when message type missing from registry', (t) => {
  const converter = new ProtobufEsBinaryPayloadConverter(createRegistry()); // empty registry
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  t.throws(() => converter.toPayload(instance), {
    instanceOf: PayloadConverterError,
    message: /cannot find corresponding message schema/,
  });
});

test('ProtobufEsBinaryPayloadConverter throws detailed errors on fromPayload', (t) => {
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const converter = new ProtobufEsBinaryPayloadConverter(registry);
  const data = toBinary(ProtoActivityInputSchema, instance);

  t.throws(
    () =>
      converter.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF },
        data,
      }),
    { instanceOf: ValueError, message: 'Got protobuf payload without metadata.messageType' }
  );

  t.throws(
    () =>
      converter.fromPayload({
        metadata: {
          [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
          [METADATA_MESSAGE_TYPE_KEY]: encode('NonExistentMessageClass'),
        },
        data,
      }),
    {
      instanceOf: PayloadConverterError,
      message:
        'Got a `NonExistentMessageClass` protobuf message but cannot find corresponding message schema in `registry`',
    }
  );

  t.throws(
    () =>
      converter.fromPayload({
        metadata: {
          [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
          [METADATA_MESSAGE_TYPE_KEY]: encode('ProtoActivityInput'),
        },
      }),
    { instanceOf: ValueError, message: 'Got payload with no data' }
  );
});

test('ProtobufEsBinaryPayloadConverter without a registry refuses to deserialize', (t) => {
  const converter = new ProtobufEsBinaryPayloadConverter();
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  t.throws(() => converter.toPayload(instance), {
    instanceOf: PayloadConverterError,
    message: /without `registry`/,
  });
  t.throws(
    () =>
      converter.fromPayload({
        metadata: {
          [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
          [METADATA_MESSAGE_TYPE_KEY]: encode('ProtoActivityInput'),
        },
        data: toBinary(ProtoActivityInputSchema, instance),
      }),
    { instanceOf: PayloadConverterError, message: /without `registry`/ }
  );
});

test('ProtobufEsBinaryPayloadConverter rejects bad registry input', (t) => {
  t.throws(() => new ProtobufEsBinaryPayloadConverter('nope' as any), { instanceOf: TypeError });
  t.throws(() => new ProtobufEsBinaryPayloadConverter({} as any), { instanceOf: TypeError });
});

test('ProtobufEsJsonPayloadConverter converts an instance to/from proto3 JSON', (t) => {
  const instance = create(NamespacedProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const converter = new ProtobufEsJsonPayloadConverter(registry);
  t.deepEqual(converter.toPayload(instance), {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: encode('foo.bar.ProtoActivityInput'),
    },
    data: encode(JSON.stringify(toJson(NamespacedProtoActivityInputSchema, instance))),
  });
});

test('ProtobufEsJsonPayloadConverter round-trips an instance', (t) => {
  const instance = create(NamespacedProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const converter = new ProtobufEsJsonPayloadConverter(registry);
  t.deepEqual(converter.fromPayload(converter.toPayload(instance)!), instance);
});

test('ProtobufEsJsonPayloadConverter handles bytes fields as base64', (t) => {
  // bytes are emitted as base64 strings in proto3 JSON
  const instance = create(BinaryMessageSchema, { data: encode('abc') });
  const converter = new ProtobufEsJsonPayloadConverter(registry);
  const payload = converter.toPayload(instance);
  t.deepEqual(payload, {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF_JSON,
      [METADATA_MESSAGE_TYPE_KEY]: encode('BinaryMessage'),
    },
    data: encode(JSON.stringify({ data: Buffer.from('abc').toString('base64') })),
  });
  const decoded = converter.fromPayload<{ data: Uint8Array }>(payload!);
  t.true(decoded.data instanceof Uint8Array);
  t.deepEqual(decoded.data, instance.data);
});

test('DefaultPayloadConverterWithProtobufsEs prefers ProtobufJson for protobuf-es messages', (t) => {
  const composite = new DefaultPayloadConverterWithProtobufsEs({ registry });
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  // Composite order is Undefined → Binary → ProtobufJson → ProtobufBinary → Json;
  // ProtobufJson wins for protobuf-es messages.
  t.deepEqual(composite.toPayload(instance), new ProtobufEsJsonPayloadConverter(registry).toPayload(instance));
});

test('DefaultPayloadConverterWithProtobufsEs delegates to non-proto converters for other values', (t) => {
  const composite = new DefaultPayloadConverterWithProtobufsEs({ registry });
  t.deepEqual(composite.toPayload('abc'), new JsonPayloadConverter().toPayload('abc'));
  t.deepEqual(composite.toPayload(undefined), new UndefinedPayloadConverter().toPayload(undefined));
  t.deepEqual(composite.toPayload(encode('abc')), new BinaryPayloadConverter().toPayload(encode('abc')));
  t.throws(() => composite.toPayload(0n), { instanceOf: ValueError });
});

test('DefaultPayloadConverterWithProtobufsEs accepts an array of schemas', (t) => {
  const composite = new DefaultPayloadConverterWithProtobufsEs({
    registry: [ProtoActivityInputSchema],
  });
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const payload = composite.toPayload(instance);
  t.deepEqual(composite.fromPayload(payload), instance);
});

test('defaultPayloadConverter has no idea what to do with a protobuf-es payload', (t) => {
  const instance = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const protoError = { instanceOf: ValueError, message: /Unknown encoding: .*protobuf/ };
  t.throws(
    () => defaultPayloadConverter.fromPayload(new ProtobufEsBinaryPayloadConverter(registry).toPayload(instance)!),
    protoError
  );
  t.throws(
    () => defaultPayloadConverter.fromPayload(new ProtobufEsJsonPayloadConverter(registry).toPayload(instance)!),
    protoError
  );
});

// -----------------------------------------------------------------------------
// Wire-compatibility: bytes produced by the protobuf-es converter must match the
// bytes produced by the existing protobufjs converter for the same logical
// message. Both converters must also be able to read each other's payloads.
// -----------------------------------------------------------------------------

const pbjsBinary = new ProtobufBinaryPayloadConverter(pbjsRoot);
const pbjsJson = new ProtobufJsonPayloadConverter(pbjsRoot);
const esBinary = new ProtobufEsBinaryPayloadConverter(registry);
const esJson = new ProtobufEsJsonPayloadConverter(registry);

// protobufjs hands back Node `Buffer`s, protobuf-es plain `Uint8Array`s. They
// share an underlying bit-pattern but `t.deepEqual` distinguishes the
// subclasses; normalize before comparing so wire-equivalence is what we test.
function asBytes(value: Uint8Array | null | undefined): Uint8Array | null | undefined {
  if (value == null) return value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

test('binary payloads from protobuf-es and protobufjs are byte-identical', (t) => {
  const esMsg = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const pbjsMsg = pbjsRoot.ProtoActivityInput.create({ name: 'Proto', age: 1 });

  const esPayload = esBinary.toPayload(esMsg)!;
  const pbjsPayload = pbjsBinary.toPayload(pbjsMsg)!;

  t.deepEqual(asBytes(esPayload.data), asBytes(pbjsPayload.data));
  t.deepEqual(esPayload.metadata, pbjsPayload.metadata);
});

test('JSON payloads from protobuf-es and protobufjs are byte-identical', (t) => {
  const esMsg = create(NamespacedProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const pbjsMsg = pbjsRoot.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });

  const esPayload = esJson.toPayload(esMsg)!;
  const pbjsPayload = pbjsJson.toPayload(pbjsMsg)!;

  t.deepEqual(asBytes(esPayload.data), asBytes(pbjsPayload.data));
  t.deepEqual(esPayload.metadata, pbjsPayload.metadata);
});

test('protobuf-es can decode a protobufjs-produced binary payload', (t) => {
  const pbjsMsg = pbjsRoot.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const payload = pbjsBinary.toPayload(pbjsMsg)!;
  const decoded = esBinary.fromPayload<{ name: string; age: number }>(payload);
  t.is(decoded.name, 'Proto');
  t.is(decoded.age, 1);
});

test('protobufjs can decode a protobuf-es-produced binary payload', (t) => {
  const esMsg = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const payload = esBinary.toPayload(esMsg)!;
  const decoded = pbjsBinary.fromPayload<{ name: string; age: number }>(payload);
  t.is(decoded.name, 'Proto');
  t.is(decoded.age, 1);
});

test('protobuf-es can decode a protobufjs-produced JSON payload', (t) => {
  const pbjsMsg = pbjsRoot.foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });
  const payload = pbjsJson.toPayload(pbjsMsg)!;
  const decoded = esJson.fromPayload<{ name: string; age: number }>(payload);
  t.is(decoded.name, 'Proto');
  t.is(decoded.age, 1);
});

test('protobufjs can decode a protobuf-es-produced JSON payload', (t) => {
  const esMsg = create(NamespacedProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const payload = esJson.toPayload(esMsg)!;
  const decoded = pbjsJson.fromPayload<{ name: string; age: number }>(payload);
  t.is(decoded.name, 'Proto');
  t.is(decoded.age, 1);
});

test('bytes-field payloads match across runtimes', (t) => {
  const esMsg = create(BinaryMessageSchema, { data: encode('abc') });
  const pbjsMsg = pbjsRoot.BinaryMessage.create({ data: encode('abc') });

  t.deepEqual(asBytes(esBinary.toPayload(esMsg)!.data), asBytes(pbjsBinary.toPayload(pbjsMsg)!.data));
  t.deepEqual(asBytes(esJson.toPayload(esMsg)!.data), asBytes(pbjsJson.toPayload(pbjsMsg)!.data));
});

// -----------------------------------------------------------------------------
// Richer proto features: nested messages, oneof, and map<string,T>. The JS
// representations differ between protobuf-es (tagged-union oneof) and
// protobufjs (flat fields), so cross-runtime JSON is asserted *after parsing*
// rather than byte-for-byte — field ordering may differ even when content is
// the same canonical proto3 JSON.
// -----------------------------------------------------------------------------

test('nested message round-trips through binary + JSON', (t) => {
  const msg = create(WrapperSchema, {
    inner: create(ProtoActivityInputSchema, { name: 'Proto', age: 1 }),
    label: 'outer',
  });

  const binRoundTrip = esBinary.fromPayload<typeof msg>(esBinary.toPayload(msg)!);
  t.deepEqual(binRoundTrip, msg);

  const jsonRoundTrip = esJson.fromPayload<typeof msg>(esJson.toPayload(msg)!);
  t.deepEqual(jsonRoundTrip, msg);
});

test('nested message binary payload matches across runtimes', (t) => {
  const esMsg = create(WrapperSchema, {
    inner: create(ProtoActivityInputSchema, { name: 'Proto', age: 1 }),
    label: 'outer',
  });
  const pbjsMsg = pbjsRoot.Wrapper.create({
    inner: pbjsRoot.ProtoActivityInput.create({ name: 'Proto', age: 1 }),
    label: 'outer',
  });

  t.deepEqual(asBytes(esBinary.toPayload(esMsg)!.data), asBytes(pbjsBinary.toPayload(pbjsMsg)!.data));
});

test('nested message JSON payload is structurally equal across runtimes', (t) => {
  const esMsg = create(WrapperSchema, {
    inner: create(ProtoActivityInputSchema, { name: 'Proto', age: 1 }),
    label: 'outer',
  });
  const pbjsMsg = pbjsRoot.Wrapper.create({
    inner: pbjsRoot.ProtoActivityInput.create({ name: 'Proto', age: 1 }),
    label: 'outer',
  });

  const esJsonObj = JSON.parse(decode(esJson.toPayload(esMsg)!.data!));
  const pbjsJsonObj = JSON.parse(decode(pbjsJson.toPayload(pbjsMsg)!.data!));
  t.deepEqual(esJsonObj, pbjsJsonObj);
});

const oneofVariants = [
  { case: 'text', value: 'hello' },
  { case: 'number', value: 42 },
  { case: 'nested', value: create(ProtoActivityInputSchema, { name: 'Proto', age: 1 }) },
] as const;
for (const variant of oneofVariants) {
  test(`oneof (${variant.case}) round-trips through binary + JSON`, (t) => {
    const msg = create(OneofMessageSchema, { choice: variant });

    t.deepEqual(esBinary.fromPayload<typeof msg>(esBinary.toPayload(msg)!), msg);
    t.deepEqual(esJson.fromPayload<typeof msg>(esJson.toPayload(msg)!), msg);
  });
}

test('oneof binary payload matches across runtimes', (t) => {
  const esMsg = create(OneofMessageSchema, { choice: { case: 'text', value: 'hello' } });
  const pbjsMsg = pbjsRoot.OneofMessage.create({ text: 'hello' });

  t.deepEqual(asBytes(esBinary.toPayload(esMsg)!.data), asBytes(pbjsBinary.toPayload(pbjsMsg)!.data));
});

test('oneof JSON payload is structurally equal across runtimes', (t) => {
  // protobuf-es emits the active oneof field by name; protobufjs's
  // proto3-json-serializer does the same. Field ordering inside the JSON
  // object may differ, hence the parse-then-deepEqual comparison.
  const esMsg = create(OneofMessageSchema, { choice: { case: 'number', value: 42 } });
  const pbjsMsg = pbjsRoot.OneofMessage.create({ number: 42 });

  const esJsonObj = JSON.parse(decode(esJson.toPayload(esMsg)!.data!));
  const pbjsJsonObj = JSON.parse(decode(pbjsJson.toPayload(pbjsMsg)!.data!));
  t.deepEqual(esJsonObj, pbjsJsonObj);
});

test('map fields round-trip through binary + JSON', (t) => {
  const msg = create(MapMessageSchema, {
    entries: { foo: 'one', bar: 'two' },
    counts: { hits: 1, misses: 2 },
  });

  t.deepEqual(esBinary.fromPayload<typeof msg>(esBinary.toPayload(msg)!), msg);
  t.deepEqual(esJson.fromPayload<typeof msg>(esJson.toPayload(msg)!), msg);
});

test('map JSON payload is structurally equal across runtimes', (t) => {
  const esMsg = create(MapMessageSchema, {
    entries: { foo: 'one', bar: 'two' },
    counts: { hits: 1, misses: 2 },
  });
  const pbjsMsg = pbjsRoot.MapMessage.create({
    entries: { foo: 'one', bar: 'two' },
    counts: { hits: 1, misses: 2 },
  });

  const esJsonObj = JSON.parse(decode(esJson.toPayload(esMsg)!.data!));
  const pbjsJsonObj = JSON.parse(decode(pbjsJson.toPayload(pbjsMsg)!.data!));
  t.deepEqual(esJsonObj, pbjsJsonObj);
});

test('map binary payload matches across runtimes', (t) => {
  // Maps encode as repeated entry messages; both runtimes iterate object keys in
  // insertion order, so byte-equal encoding requires identical key order at the source.
  const init = {
    entries: { foo: 'one', bar: 'two' },
    counts: { hits: 1, misses: 2 },
  };
  const esMsg = create(MapMessageSchema, init);
  const pbjsMsg = pbjsRoot.MapMessage.create(init);

  t.deepEqual(asBytes(esBinary.toPayload(esMsg)!.data), asBytes(pbjsBinary.toPayload(pbjsMsg)!.data));
});

test('int64 + enum round-trip through binary + JSON', (t) => {
  // int64 in proto3 JSON is encoded as a quoted string; protobuf-es represents
  // it as a bigint at the JS level.
  const msg = create(NumbersAndEnumSchema, { big: 9_000_000_000n, color: Color.BLUE });

  t.deepEqual(esBinary.fromPayload<typeof msg>(esBinary.toPayload(msg)!), msg);
  t.deepEqual(esJson.fromPayload<typeof msg>(esJson.toPayload(msg)!), msg);
});

test('int64 + enum JSON payload is proto3-JSON compliant in protobuf-es', (t) => {
  // proto3 JSON spec mandates: int64 serialized as a quoted string, enum as
  // its named value. protobuf-es is strictly compliant. protobufjs's
  // proto3-json-serializer is not always — it emits int64 as a number — so we
  // intentionally only assert the protobuf-es side here; cross-runtime
  // structural equality holds for simpler types (see Wrapper/oneof/map
  // tests above) but breaks for int64.
  const esMsg = create(NumbersAndEnumSchema, { big: 9_000_000_000n, color: Color.BLUE });
  const esJsonObj = JSON.parse(decode(esJson.toPayload(esMsg)!.data!));
  t.is(esJsonObj.big, '9000000000');
  t.is(esJsonObj.color, 'COLOR_BLUE');
});

test('int64 + enum binary payload matches across runtimes', (t) => {
  const esMsg = create(NumbersAndEnumSchema, { big: 9_000_000_000n, color: Color.BLUE });
  const pbjsMsg = pbjsRoot.NumbersAndEnum.create({ big: 9_000_000_000, color: 3 });

  t.deepEqual(asBytes(esBinary.toPayload(esMsg)!.data), asBytes(pbjsBinary.toPayload(pbjsMsg)!.data));
});

test('JSON round-trip of google.protobuf.Any unpacks the embedded message via the registry', (t) => {
  // google.protobuf.Any's proto3 JSON form requires the registry to resolve the inner type.
  const inner = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const packed = anyPack(ProtoActivityInputSchema, inner);

  const payload = esJson.toPayload(packed)!;
  const json = JSON.parse(decode(payload.data!));
  t.is(json['@type'], 'type.googleapis.com/ProtoActivityInput');
  t.is(json.name, 'Proto');
  t.is(json.age, 1);

  const decoded = esJson.fromPayload<typeof packed>(payload);
  const unpacked = anyUnpack(decoded, ProtoActivityInputSchema);
  t.deepEqual(unpacked, inner);
});

test('JSON round-trip of google.protobuf.Any without registry knowledge of the inner type throws', (t) => {
  // Proves toJson actually consults the registry rather than silently emitting an unrenderable Any.
  const limited = new ProtobufEsJsonPayloadConverter([AnySchema]);
  const inner = create(ProtoActivityInputSchema, { name: 'Proto', age: 1 });
  const packed = anyPack(ProtoActivityInputSchema, inner);
  t.throws(() => limited.toPayload(packed), {
    message: /"type\.googleapis\.com\/ProtoActivityInput".*type registry/,
  });
});

test('plain object with $typeName but no registry match surfaces as PayloadConverterError', (t) => {
  // The cheap structural check (presence of `$typeName: string`) is the only
  // brand a protobuf-es message exposes at runtime. A user JSON value that
  // happens to share that shape will be claimed by the protobuf-es converter
  // BEFORE JsonPayloadConverter gets a chance — and fail with a clear
  // registry-lookup error rather than silently round-tripping as JSON. This
  // test pins that contract.
  const composite = new DefaultPayloadConverterWithProtobufsEs({ registry });
  const lookalike = { $typeName: 'NotARegisteredMessage', anyOtherField: 1 };
  t.throws(() => composite.toPayload(lookalike), {
    instanceOf: PayloadConverterError,
    message: /cannot find corresponding message schema in `registry`/,
  });
});

// -----------------------------------------------------------------------------
// Sandbox integration: bundle and run a workflow that echoes a protobuf-es
// message back through the workflow sandbox + Core. This exercises the bundler
// (webpack/swc), the v8 isolate, and the round-trip through Core's gRPC server.
// -----------------------------------------------------------------------------

if (RUN_INTEGRATION_TESTS) {
  // `test.serial` so the three integration tests run in declaration order;
  // `Runtime.install` below must execute before any Worker is constructed,
  // which would otherwise instantiate the default Runtime and lock the install
  // out with "already instantiated".
  test.serial('Worker surfaces missing-schema-in-registry as a workflow task failure', async (t) => {
    let markErrorThrown: () => void;
    const expectedErrorWasThrown = new Promise<void>((resolve) => {
      markErrorThrown = resolve;
    });

    Runtime.install({
      logger: new DefaultLogger('WARN', (entry) => {
        if (
          entry.message.includes('Failing workflow task') &&
          entry.meta?.failure?.includes('cannot find corresponding message schema in `registry`')
        ) {
          markErrorThrown();
        }
      }),
      telemetryOptions: { logging: { forward: {}, filter: 'WARN' } },
    });

    const taskQueue = `${__filename}/${t.title}`;
    // Worker uses a payload converter whose registry is empty: it understands
    // the protobuf encoding marker but knows zero schemas. Decoding the
    // ProtoActivityInput payload the client sends must fail cleanly.
    const worker = await Worker.create({
      ...defaultOptions,
      workflowsPath: require.resolve('./workflows/echo-protobuf-es-input'),
      taskQueue,
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/proto-es-payload-converter-empty-registry'),
      },
    });
    const client = new WorkflowClient({
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/proto-es-payload-converter'),
      },
    });

    const handle = await client.start(echoProtoEsInput, {
      args: [create(ProtoActivityInputSchema, { name: 'Proto', age: 1 })],
      workflowId: uuid4(),
      taskQueue,
    });

    await worker.runUntil(async () => {
      try {
        await expectedErrorWasThrown;
      } finally {
        await handle.terminate();
      }
    });
    t.pass();
  });

  test.serial('Worker round-trips a protobuf-es BinaryMessage through the sandbox', async (t) => {
    const binaryInstance = create(BinaryMessageSchema, { data: encode('abc') });
    const dataConverter = {
      payloadConverterPath: require.resolve('./payload-converters/proto-es-payload-converter'),
    };
    const taskQueue = `${__filename}/${t.title}`;

    const worker = await Worker.create({
      ...defaultOptions,
      workflowsPath: require.resolve('./workflows/echo-binary-protobuf-es'),
      taskQueue,
      dataConverter,
    });

    const client = new WorkflowClient({ dataConverter });

    await worker.runUntil(async () => {
      const result = await client.execute(echoBinaryProtobufEs, {
        args: [binaryInstance],
        workflowId: uuid4(),
        taskQueue,
      });
      // protobuf-es messages carry a non-enumerable $typeName which deepEqual
      // ignores when one side lacks it after cross-realm transfer; assert the
      // observable fields explicitly so we get a clear failure.
      t.true((result as EsBinaryMessageType).data instanceof Uint8Array);
      t.deepEqual((result as EsBinaryMessageType).data, binaryInstance.data);
    });
  });

  test.serial('Worker round-trips protobuf-es messages through signal, query, and update', async (t) => {
    const dataConverter = {
      payloadConverterPath: require.resolve('./payload-converters/proto-es-payload-converter'),
    };
    const taskQueue = `${__filename}/${t.title}`;

    const worker = await Worker.create({
      ...defaultOptions,
      workflowsPath: require.resolve('./workflows/protobufs-es-signals-queries-updates'),
      taskQueue,
      dataConverter,
    });

    const client = new WorkflowClient({ dataConverter });

    await worker.runUntil(async () => {
      const handle = await client.start(protobufEsSignalsQueriesUpdates, {
        args: [],
        workflowId: uuid4(),
        taskQueue,
      });

      const sentSignal = create(ProtoActivityInputSchema, { name: 'Signal', age: 7 });
      await handle.signal(setInputSignal, sentSignal);

      // Query: the workflow stores whatever the signal handed it.
      const queried = await handle.query(getInputQuery);
      t.is(queried?.name, 'Signal');
      t.is(queried?.age, 7);

      // Update: the workflow consumes a message arg and returns a message.
      const updateArg = create(ProtoActivityInputSchema, { name: 'Update', age: 9 });
      const updateResult = await handle.executeUpdate(sentenceUpdate, { args: [updateArg] });
      t.is(updateResult.sentence, 'Update is 9');

      await handle.signal(finishSignal);
      const final = await handle.result();
      // Final result is the most-recent setInputSignal value (sentSignal).
      t.is(final.name, 'Signal');
      t.is(final.age, 7);
    });
  });
}
