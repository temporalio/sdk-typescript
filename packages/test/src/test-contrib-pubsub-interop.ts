/**
 * Wire-format interop tests for @temporalio/contrib-pubsub.
 *
 * These tests pin the exact byte layout produced by the TypeScript
 * implementation so it stays compatible with the Python SDK, which
 * uses `temporalio.api.common.v1.Payload` serialized via protobuf.
 *
 * Unlike `test-contrib-pubsub.ts`, these don't need a Temporal server —
 * they are pure encode/decode unit tests.
 */

import anyTest, { TestFn } from 'ava';
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import {
  decodeBase64,
  decodePayloadProto,
  decodePayloadWire,
  encodeBase64,
  encodePayloadProto,
  encodePayloadWire,
} from '@temporalio/contrib-pubsub';

const test = anyTest as TestFn;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('payload_proto_round_trips_for_default_json_string', (t) => {
  // The default JSON converter wraps "hello" as:
  //   metadata = {encoding: b"json/plain"}, data = b'"hello"'
  //
  // Proto encoding layout we're pinning:
  //   field 1 (metadata map entry): "encoding" -> b"json/plain"
  //   field 2 (data): b'"hello"'
  const payload = defaultPayloadConverter.toPayload('hello');
  const wire = encodePayloadWire(payload);

  const expected = encodeBase64(
    new Uint8Array([
      0x0a,
      0x16, // metadata entry: field 1, wire-type 2, len 22
      0x0a,
      0x08, // inner key: field 1, len 8
      ...encoder.encode('encoding'),
      0x12,
      0x0a, // inner value: field 2, len 10
      ...encoder.encode('json/plain'),
      0x12,
      0x07, // data: field 2, len 7
      ...encoder.encode('"hello"'),
    ])
  );
  t.is(wire, expected);

  const decoded = decodePayloadWire(wire);
  t.is(decoder.decode(decoded.metadata!['encoding']!), 'json/plain');
  t.deepEqual(decoded.data, encoder.encode('"hello"'));
});

test('binary_payload_round_trips_through_wire', (t) => {
  const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
  const payload = defaultPayloadConverter.toPayload(bytes);
  const wire = encodePayloadWire(payload);
  const decoded = decodePayloadWire(wire);

  t.is(decoder.decode(decoded.metadata!['encoding']!), 'binary/plain');
  t.deepEqual(decoded.data, bytes);
});

test('decode_accepts_python_generated_bytes', (t) => {
  // Construct a Payload exactly as Python's protobuf runtime would emit
  // (metadata = {encoding: "binary/plain"}, data = b"ping") and verify our
  // decoder round-trips it.
  const data = encoder.encode('ping');
  const pythonLikeProto = new Uint8Array([
    0x0a,
    0x18, // field 1, len 24
    0x0a,
    0x08, // key tag, len 8
    ...encoder.encode('encoding'),
    0x12,
    0x0c, // value tag, len 12
    ...encoder.encode('binary/plain'),
    0x12,
    0x04, // data tag, len 4
    ...data,
  ]);
  const wire = encodeBase64(pythonLikeProto);
  const decoded = decodePayloadWire(wire);
  t.is(decoder.decode(decoded.metadata!['encoding']!), 'binary/plain');
  t.deepEqual(decoded.data, data);
});

test('empty_payload_encodes_to_empty_bytes', (t) => {
  // Matches Python: Payload().SerializeToString() returns b"".
  const wire = encodePayloadWire({ metadata: {}, data: new Uint8Array(0) });
  t.is(wire, '');

  const decoded = decodePayloadWire('');
  t.deepEqual(decoded.metadata, {});
  t.is(decoded.data?.length ?? 0, 0);
});

test('varint_length_handles_multi_byte_prefix', (t) => {
  // Sizes >= 128 require a multi-byte varint length prefix. Verify both
  // encode and decode handle the boundary correctly (Python protobuf
  // uses the same varint encoding).
  const big = new Uint8Array(300).fill(0x42); // 300 bytes, varint = [0xac, 0x02]
  const payload = defaultPayloadConverter.toPayload(big);
  const wire = encodePayloadWire(payload);
  const decoded = decodePayloadWire(wire);
  t.deepEqual(decoded.data, big);
});

test('multiple_metadata_entries_round_trip', (t) => {
  const payload: Payload = {
    metadata: {
      encoding: encoder.encode('json/plain'),
      messageType: encoder.encode('MyType'),
    },
    data: encoder.encode('{"x":1}'),
  };
  const wire = encodePayloadWire(payload);
  const decoded = decodePayloadWire(wire);
  t.is(decoder.decode(decoded.metadata!['encoding']!), 'json/plain');
  t.is(decoder.decode(decoded.metadata!['messageType']!), 'MyType');
  t.deepEqual(decoded.data, encoder.encode('{"x":1}'));
});

test('base64_helpers_match_standard_encoding', (t) => {
  // Standard base64 (with padding) must match what Python's base64.b64encode
  // produces — RFC 4648 §4. Spot-check the canonical rfc4648 examples.
  t.is(encodeBase64(encoder.encode('')), '');
  t.is(encodeBase64(encoder.encode('f')), 'Zg==');
  t.is(encodeBase64(encoder.encode('fo')), 'Zm8=');
  t.is(encodeBase64(encoder.encode('foo')), 'Zm9v');
  t.is(encodeBase64(encoder.encode('foob')), 'Zm9vYg==');
  t.is(encodeBase64(encoder.encode('foobar')), 'Zm9vYmFy');

  t.deepEqual(decodeBase64(''), new Uint8Array(0));
  t.deepEqual(decodeBase64('Zm9vYmFy'), encoder.encode('foobar'));
  t.deepEqual(decodeBase64('Zg=='), encoder.encode('f'));
});

test('unknown_fields_are_skipped_on_decode', (t) => {
  // Forward compatibility: if Payload proto grows a new field (e.g.
  // externalPayloads = 3), our decoder skips it without aborting. The
  // Python generated class behaves the same way.
  const data = encoder.encode('hi');
  const bytesWithUnknownField = new Uint8Array([
    0x12,
    0x02,
    ...data,
    // field 3 (unknown), wire-type 2, len 3 — skipped
    0x1a,
    0x03,
    0xaa,
    0xbb,
    0xcc,
  ]);
  const decoded = decodePayloadProto(bytesWithUnknownField);
  t.deepEqual(decoded.data, data);
});

test('encode_produces_canonical_bytes', (t) => {
  // Pin a known byte sequence. If encodePayloadProto ever produces
  // different bytes for this input, Python consumers break — this test
  // catches that before it ships.
  const payload: Payload = {
    metadata: { encoding: encoder.encode('binary/plain') },
    data: encoder.encode('abc'),
  };
  const bytes = encodePayloadProto(payload);
  const expected = new Uint8Array([
    0x0a,
    0x18, // field 1, len 24
    0x0a,
    0x08, // key tag, len 8
    ...encoder.encode('encoding'),
    0x12,
    0x0c, // value tag, len 12
    ...encoder.encode('binary/plain'),
    0x12,
    0x03, // data tag, len 3
    ...encoder.encode('abc'),
  ]);
  t.deepEqual(bytes, expected);
});

test('round_trip_preserves_all_fields', (t) => {
  // Hermetic round-trip: every field survives encode -> decode.
  const cases: Payload[] = [
    { metadata: { encoding: encoder.encode('json/plain') }, data: encoder.encode('true') },
    { metadata: { encoding: encoder.encode('binary/null') }, data: new Uint8Array(0) },
    {
      metadata: {
        encoding: encoder.encode('json/protobuf'),
        messageType: encoder.encode('my.pkg.Thing'),
      },
      data: new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255]),
    },
  ];
  for (const input of cases) {
    const wire = encodePayloadWire(input);
    const out = decodePayloadWire(wire);
    t.is(Object.keys(out.metadata ?? {}).length, Object.keys(input.metadata ?? {}).length);
    for (const [k, v] of Object.entries(input.metadata ?? {})) {
      t.deepEqual(out.metadata?.[k], v);
    }
    t.deepEqual(out.data ?? new Uint8Array(0), input.data ?? new Uint8Array(0));
  }
});
