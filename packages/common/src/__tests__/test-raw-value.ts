import test from 'ava';
import { defaultDataConverter } from '../converter/data-converter';
import type { PayloadCodec } from '../converter/payload-codec';
import {
  defaultPayloadConverter,
  RawValue,
  rawValueTypeInfo,
  toPayloadWithTypeInfo,
  type PayloadConverter,
} from '../converter/payload-converter';
import { ValueError } from '../errors';
import type { Payload } from '../interfaces';
import { decodeFromPayloadsAtIndex, encodeToPayload } from '../internal-non-workflow/codec-helpers';

test('preserves RawValue TypeInfo around codecs without payload conversion', async (t) => {
  const payload: Payload = {
    metadata: {},
    data: Uint8Array.from([1, 2, 3]),
  };
  const stages: string[] = [];
  const payloadConverter: PayloadConverter = {
    toPayload: () => {
      throw new Error('Unexpected payload encoding');
    },
    fromPayload: () => {
      throw new Error('Unexpected payload decoding');
    },
  };
  const payloadCodec: PayloadCodec = {
    async encode(payloads) {
      stages.push('encode');
      return payloads;
    },
    async decode(payloads) {
      stages.push('decode');
      return payloads;
    },
  };
  const converter = { ...defaultDataConverter, payloadConverter, payloadCodecs: [payloadCodec] };

  const encoded = await encodeToPayload(converter, RawValue.fromPayload(payload), undefined, rawValueTypeInfo);
  const decoded = await decodeFromPayloadsAtIndex(converter, 0, [encoded], undefined, rawValueTypeInfo);

  t.deepEqual(stages, ['encode', 'decode']);
  t.is(encoded, payload);
  t.true(decoded instanceof RawValue);
  t.deepEqual(decoded.payload, payload);
});

test('rejects a non-RawValue with RawValue TypeInfo', (t) => {
  const invalidValue = 'not a RawValue' as unknown as RawValue;

  t.throws(() => toPayloadWithTypeInfo(defaultPayloadConverter, invalidValue, undefined, rawValueTypeInfo), {
    instanceOf: ValueError,
    message: 'RawValue TypeInfo requires a RawValue value',
  });
});

test('preserves direct CompositePayloadConverter RawValue conversion', (t) => {
  const value = new RawValue('test');

  t.is(defaultPayloadConverter.toPayload(value), value.payload);
});
