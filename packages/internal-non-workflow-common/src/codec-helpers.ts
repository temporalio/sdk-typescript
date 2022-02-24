import {
  arrayFromPayloads,
  errorToFailure,
  failureToError,
  fromPayloadsAtIndex,
  LoadedDataConverter,
  Payload,
  PayloadCodec,
  ProtoFailure,
  TemporalFailure,
  toPayloads,
} from '@temporalio/common';
import { clone, setWith } from 'lodash';

/**
 * Decode `payloads` and then return {@link fromPayloadsAtIndex}.
 */
export async function decodeFromPayloadsAtIndex<T>(
  converter: LoadedDataConverter,
  index: number,
  payloads?: Payload[] | null
): Promise<T> {
  const { payloadConverter, payloadCodec } = converter;
  return fromPayloadsAtIndex(payloadConverter, index, payloads ? await payloadCodec.decode(payloads) : payloads);
}

/**
 * Decode `payloads` and then return {@link arrayFromPayloads}`.
 */
export async function decodeArrayFromPayloads(
  converter: LoadedDataConverter,
  payloads?: Payload[] | null
): Promise<unknown[]> {
  const { payloadConverter, payloadCodec } = converter;
  let decodedPayloads = payloads;
  if (payloads) {
    decodedPayloads = await payloadCodec.decode(payloads);
  }
  return arrayFromPayloads(payloadConverter, decodedPayloads);
}

/**
 * Run {@link decodeFailure} and then return {@link failureToError}.
 */
export async function decodeOptionalFailureToOptionalError(
  converter: LoadedDataConverter,
  failure: ProtoFailure | undefined | null
): Promise<TemporalFailure | undefined> {
  const { payloadConverter, payloadCodec } = converter;
  return failure ? failureToError(await decodeFailure(payloadCodec, failure), payloadConverter) : undefined;
}

/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export async function encodeToPayload(converter: LoadedDataConverter, value: unknown): Promise<Payload> {
  const { payloadConverter, payloadCodec } = converter;
  const [payload] = await payloadCodec.encode([payloadConverter.toPayload(value)]);
  return payload;
}

/**
 * Run {@link PayloadConverter.toPayload} on values, and then encode them.
 */
export async function encodeToPayloads(
  converter: LoadedDataConverter,
  ...values: unknown[]
): Promise<Payload[] | undefined> {
  const { payloadConverter, payloadCodec } = converter;
  if (values.length === 0) {
    return undefined;
  }
  const payloads = toPayloads(payloadConverter, values);
  return payloads ? await payloadCodec.encode(payloads) : undefined;
}

/**
 * Run {@link PayloadConverter.toPayload} and {@link PayloadCodec.encode} on values in `map`.
 */
export async function encodeMapToPayloads<K extends string>(
  converter: LoadedDataConverter,
  map: Record<K, any>
): Promise<Record<K, Payload>> {
  const { payloadConverter, payloadCodec } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, v]): Promise<[K, Payload]> => {
        const [payload] = await payloadCodec.encode([payloadConverter.toPayload(v)]);
        return [k as K, payload];
      })
    )
  ) as Record<K, Payload>;
}

/**
 * Run {@link errorToFailure} on `error`, and then {@link encodeFailure}.
 */
export async function encodeErrorToFailure(dataConverter: LoadedDataConverter, error: unknown): Promise<ProtoFailure> {
  const { payloadConverter, payloadCodec } = dataConverter;
  return await encodeFailure(payloadCodec, errorToFailure(error, payloadConverter));
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeFailure(codec: PayloadCodec, failure: ProtoFailure): Promise<ProtoFailure> {
  const encodedFailure = { ...failure };
  if (failure.cause) {
    encodedFailure.cause = await encodeFailure(codec, failure.cause);
  }

  if (encodedFailure.applicationFailureInfo?.details?.payloads?.length) {
    setWith(
      encodedFailure,
      'applicationFailureInfo.details.payloads',
      await codec.encode(encodedFailure.applicationFailureInfo.details.payloads),
      clone
    );
  }
  if (encodedFailure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    setWith(
      encodedFailure,
      'timeoutFailureInfo.lastHeartbeatDetails.payloads',
      await codec.encode(encodedFailure.timeoutFailureInfo.lastHeartbeatDetails.payloads),
      clone
    );
  }
  if (encodedFailure.canceledFailureInfo?.details?.payloads?.length) {
    setWith(
      encodedFailure,
      'canceledFailureInfo.details.payloads',
      await codec.encode(encodedFailure.canceledFailureInfo.details.payloads),
      clone
    );
  }
  if (encodedFailure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    setWith(
      encodedFailure,
      'resetWorkflowFailureInfo.lastHeartbeatDetails.payloads',
      await codec.encode(encodedFailure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads),
      clone
    );
  }
  return encodedFailure;
}

/**
 * Return a new {@link ProtoFailure} with `codec.decode()` run on all the {@link Payload}s.
 */
export async function decodeFailure(codec: PayloadCodec, failure: ProtoFailure): Promise<ProtoFailure> {
  const decodedFailure = { ...failure };
  if (failure.cause) {
    decodedFailure.cause = await decodeFailure(codec, failure.cause);
  }

  if (decodedFailure.applicationFailureInfo?.details?.payloads?.length) {
    setWith(
      decodedFailure,
      'applicationFailureInfo.details.payloads',
      await codec.decode(decodedFailure.applicationFailureInfo.details.payloads),
      clone
    );
  }
  if (decodedFailure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    setWith(
      decodedFailure,
      'timeoutFailureInfo.lastHeartbeatDetails.payloads',
      await codec.decode(decodedFailure.timeoutFailureInfo.lastHeartbeatDetails.payloads),
      clone
    );
  }
  if (decodedFailure.canceledFailureInfo?.details?.payloads?.length) {
    setWith(
      decodedFailure,
      'canceledFailureInfo.details.payloads',
      await codec.decode(decodedFailure.canceledFailureInfo.details.payloads),
      clone
    );
  }
  if (decodedFailure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    setWith(
      decodedFailure,
      'resetWorkflowFailureInfo.lastHeartbeatDetails.payloads',
      await codec.decode(decodedFailure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads),
      clone
    );
  }
  return decodedFailure;
}
