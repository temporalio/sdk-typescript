import test from 'ava';
import type { LoadedDataConverter, Payload, PayloadCodec, TypeInfo } from '@temporalio/common';
import {
  ApplicationFailure,
  CancelledFailure,
  defaultDataConverter,
  defaultPayloadConverter,
  fromPayloadWithTypeInfo,
} from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/protobufs';
import { decode, encode, visit, walkPayloadsInMessage } from '@temporalio/common/internal/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import type { temporal } from '@temporalio/proto';
import {
  type OnCompleteRequest,
  type OnCompleteResponse,
  onCompleteRequestTransferTypeConverter,
  onCompleteResponseTransferTypeConverter,
} from '../nexus/system/generated/notifications';
import { withSystemNexusPayloadConversion } from '../nexus/system/user-payload-converter';

const { OnCompleteRequest: Request, OnCompleteResponse: Response } = protoRoot.temporal.api.notificationservice.v1;
const protobufConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const context = { type: 'workflow', namespace: 'test-namespace', workflowId: 'test-workflow' } as const;
type Notification = OnCompleteRequest<{ value: string }, { source: string }>;
const requestType: TypeInfo<Notification, temporal.api.notificationservice.v1.IOnCompleteRequest> = {
  transferTypeConverter: onCompleteRequestTransferTypeConverter,
};
const responseType: TypeInfo<OnCompleteResponse, temporal.api.notificationservice.v1.IOnCompleteResponse> = {
  transferTypeConverter: onCompleteResponseTransferTypeConverter,
};

// Exercise the same boundary as System Nexus: convert values inside the request, visit only
// the nested payloads for codecs, and serialize the outer message as binary/protobuf.
async function encodeNotification<Model, Wire extends object>(
  dataConverter: LoadedDataConverter,
  model: Model,
  typeInfo: TypeInfo<Model, Wire>,
  create: (wire: Wire) => object
): Promise<Payload> {
  const wire = withSystemNexusPayloadConversion(dataConverter.payloadConverter, context, () =>
    typeInfo.transferTypeConverter!.toTransferType(model)
  );
  const message = create(wire);
  await transformNestedPayloads(message, dataConverter, 'encode');
  return protobufConverter.toPayload(message)!;
}

async function decodeNotification<Model, Wire>(
  dataConverter: LoadedDataConverter,
  payload: Payload,
  typeInfo: TypeInfo<Model, Wire>
): Promise<Model> {
  const message = protobufConverter.fromPayload<object>(payload);
  await transformNestedPayloads(message, dataConverter, 'decode');
  return withSystemNexusPayloadConversion(dataConverter.payloadConverter, context, () =>
    fromPayloadWithTypeInfo(protobufConverter, protobufConverter.toPayload(message)!, context, typeInfo)
  );
}

async function transformNestedPayloads(
  message: object,
  dataConverter: LoadedDataConverter,
  direction: 'encode' | 'decode'
): Promise<void> {
  const transform = direction === 'encode' ? encode : decode;
  await visit(message, walkPayloadsInMessage, {
    transformPayload: async (payload, ctx) => (await transform(dataConverter.payloadCodecs, [payload], ctx))[0]!,
    transformPayloads: (payloads, ctx) => transform(dataConverter.payloadCodecs, payloads, ctx),
    initialContext: context,
  });
}

// Replace each entire leaf payload, not just its data. Missing or repeated codec visits will
// fail decoding; walking the outer envelope instead of its leaves will fail the wire assertions.
function makeCodec(): PayloadCodec {
  return {
    async encode(payloads) {
      return payloads.map((payload) => ({
        metadata: { encoding: new TextEncoder().encode('binary/test-codec') },
        data: protoRoot.temporal.api.common.v1.Payload.encode(payload).finish(),
      }));
    },
    async decode(payloads) {
      return payloads.map((payload) => {
        if (new TextDecoder().decode(payload.metadata?.encoding) !== 'binary/test-codec') {
          throw new Error('expected a codec-encoded nested payload');
        }
        return protoRoot.temporal.api.common.v1.Payload.decode(payload.data!);
      });
    },
  };
}

for (const withCodec of [false, true]) {
  const suffix = withCodec ? 'with codec' : 'without codec';
  const converter: LoadedDataConverter = {
    ...defaultDataConverter,
    payloadCodecs: withCodec ? [makeCodec()] : [],
  };
  const expectedEncoding = withCodec ? 'binary/test-codec' : 'json/plain';
  const encoding = (payload: temporal.api.common.v1.IPayload | null | undefined): string =>
    new TextDecoder().decode(payload?.metadata?.encoding);

  test(`notification success round trips typed output and source context ${suffix}`, async (t) => {
    const request: Notification = {
      result: { tag: 'success', value: { value: 'finished' } },
      sourceContext: { source: 'caller' },
    };
    const payload = await encodeNotification(converter, request, requestType, (wire) => Request.create(wire));
    t.is(encoding(payload), 'binary/protobuf');
    t.is(
      new TextDecoder().decode(payload.metadata?.messageType),
      'temporal.api.notificationservice.v1.OnCompleteRequest'
    );
    const wire = Request.decode(payload.data!);
    t.is(wire.result, 'success');
    t.is(encoding(wire.success), expectedEncoding);
    t.is(encoding(wire.sourceContext), expectedEncoding);
    t.deepEqual(await decodeNotification(converter, payload, requestType), request);
  });

  test(`notification failure round trips application failure details and cause ${suffix}`, async (t) => {
    const failure = ApplicationFailure.create({
      message: 'failed',
      type: 'OperationError',
      nonRetryable: true,
      details: ['diagnostic', { code: 42 }],
      cause: new CancelledFailure('cancelled', ['cancellation detail']),
    });
    const request: Notification = {
      result: { tag: 'failure', value: failure },
      sourceContext: { source: 'caller' },
    };
    const payload = await encodeNotification(converter, request, requestType, (wire) => Request.create(wire));
    const wire = Request.decode(payload.data!);
    t.is(encoding(payload), 'binary/protobuf');
    t.is(wire.result, 'failure');
    t.is(wire.failure?.applicationFailureInfo?.type, 'OperationError');
    t.is(encoding(wire.sourceContext), expectedEncoding);
    t.is(encoding(wire.failure?.applicationFailureInfo?.details?.payloads?.[0]), expectedEncoding);
    t.is(encoding(wire.failure?.applicationFailureInfo?.details?.payloads?.[1]), expectedEncoding);
    t.is(encoding(wire.failure?.cause?.canceledFailureInfo?.details?.payloads?.[0]), expectedEncoding);

    const restored = await decodeNotification(converter, payload, requestType);
    t.deepEqual(restored.sourceContext, request.sourceContext);
    t.is(restored.result.tag, 'failure');
    t.true(restored.result.value instanceof ApplicationFailure);
    const error = restored.result.value as ApplicationFailure;
    t.is(error.message, 'failed');
    t.is(error.type, 'OperationError');
    t.true(error.nonRetryable);
    t.deepEqual(error.details, ['diagnostic', { code: 42 }]);
    t.true(error.cause instanceof CancelledFailure);
    t.deepEqual((error.cause as CancelledFailure).details, ['cancellation detail']);
  });

  test(`empty notification response round trips ${suffix}`, async (t) => {
    const payload = await encodeNotification(converter, {}, responseType, (wire) => Response.create(wire));
    t.is(encoding(payload), 'binary/protobuf');
    t.is(
      new TextDecoder().decode(payload.metadata?.messageType),
      'temporal.api.notificationservice.v1.OnCompleteResponse'
    );
    t.is(payload.data?.length, 0);
    t.deepEqual(await decodeNotification(converter, payload, responseType), {});
  });
}

test('notification conversion uses the configured payload converter and serialization context', async (t) => {
  let encoded = 0;
  let decoded = 0;
  const converter: LoadedDataConverter = {
    ...defaultDataConverter,
    payloadConverter: {
      toPayload(value, ctx) {
        t.deepEqual(ctx, context);
        encoded++;
        return defaultPayloadConverter.toPayload({ wrapped: value });
      },
      fromPayload<T>(payload: Payload, ctx?: typeof context): T {
        t.deepEqual(ctx, context);
        decoded++;
        return defaultPayloadConverter.fromPayload<{ wrapped: T }>(payload).wrapped;
      },
    },
    payloadCodecs: [makeCodec()],
  };
  const request: Notification = {
    result: { tag: 'success', value: { value: 'finished' } },
    sourceContext: { source: 'caller' },
  };
  const payload = await encodeNotification(converter, request, requestType, (wire) => Request.create(wire));
  t.deepEqual(await decodeNotification(converter, payload, requestType), request);
  t.is(encoded, 2);
  t.is(decoded, 2);
});

test('notification request rejects a missing result or missing source context', (t) => {
  const value = defaultPayloadConverter.toPayload('value');
  t.throws(
    () =>
      withSystemNexusPayloadConversion(defaultPayloadConverter, context, () =>
        onCompleteRequestTransferTypeConverter.fromTransferType(Request.create({ sourceContext: value }))
      ),
    { message: 'missing required field OnCompleteRequest.result' }
  );
  t.throws(
    () =>
      withSystemNexusPayloadConversion(defaultPayloadConverter, context, () =>
        onCompleteRequestTransferTypeConverter.fromTransferType(Request.create({ success: value }))
      ),
    { message: 'missing required field OnCompleteRequest.sourceContext' }
  );
});

test('notification request rejects a selected result with no payload', (t) => {
  const sourceContext = defaultPayloadConverter.toPayload('source');
  for (const result of ['success', 'failure'] as const) {
    t.throws(
      () =>
        withSystemNexusPayloadConversion(defaultPayloadConverter, context, () =>
          onCompleteRequestTransferTypeConverter.fromTransferType({ result, sourceContext })
        ),
      { message: `missing required field OnCompleteRequest.${result}` }
    );
  }
});

test('notification success and source context can contain undefined values', async (t) => {
  const request: OnCompleteRequest<undefined, undefined> = {
    result: { tag: 'success', value: undefined },
    sourceContext: undefined,
  };
  const typeInfo: TypeInfo<typeof request, temporal.api.notificationservice.v1.IOnCompleteRequest> = {
    transferTypeConverter: onCompleteRequestTransferTypeConverter,
  };
  const converter = { ...defaultDataConverter, payloadCodecs: [makeCodec()] };
  const payload = await encodeNotification(converter, request, typeInfo, (wire) => Request.create(wire));
  t.deepEqual(await decodeNotification(converter, payload, typeInfo), request);
});
