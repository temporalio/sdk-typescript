import {
  arrayFromPayloads,
  EncodedPayload,
  EncodedProtoFailure,
  errorToFailure,
  failureToError,
  fromPayloadsAtIndex,
  LoadedDataConverter,
  Payload,
  PayloadCodec,
  PayloadConverterError,
  ProtoFailure,
  TemporalFailure,
  toPayload,
  toPayloads,
} from '@temporalio/common';
import { clone, setWith } from 'lodash';

export interface TypecheckedPayloadCodec {
  encode(payloads: Payload[]): Promise<EncodedPayload[]>;
  decode(payloads: Payload[]): Promise<Payload[]>;
}

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

/** Run {@link PayloadCodec.encode} on a single Payload */
export async function encodeOptional(
  codec: PayloadCodec,
  payloads: Payload[] | null | undefined
): Promise<EncodedPayload[] | null | undefined> {
  if (!payloads) return payloads;
  return (await codec.encode(payloads)) as EncodedPayload[];
}

async function encodeSingle(codec: PayloadCodec, payload: Payload): Promise<EncodedPayload> {
  const encodedPayloads = await codec.encode([payload]);
  return encodedPayloads[0] as EncodedPayload;
}

/** Run {@link PayloadCodec.encode} on a single Payload */
export async function encodeOptionalSingle(
  codec: PayloadCodec,
  payload: Payload | null | undefined
): Promise<EncodedPayload | null | undefined> {
  if (!payload) return payload;
  return await encodeSingle(codec, payload);
}

/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export async function encodeToPayload(converter: LoadedDataConverter, value: unknown): Promise<Payload> {
  const { payloadConverter, payloadCodec } = converter;
  return await encodeSingle(payloadCodec, toPayload(payloadConverter, value));
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
  const payloads = toPayloads(payloadConverter, ...values);
  return payloads ? await payloadCodec.encode(payloads) : undefined;
}

/** Run {@link PayloadCodec.encode} on all values in `map` */
export async function encodeMap<K extends string>(
  codec: PayloadCodec,
  map: Record<K, Payload> | null | undefined
): Promise<Record<K, EncodedPayload> | null | undefined> {
  if (!map) return map;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, payload]): Promise<[K, EncodedPayload]> => {
        return [k as K, await encodeSingle(codec, payload as Payload)];
      })
    )
  ) as Record<K, EncodedPayload>;
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
        const payload = payloadConverter.toPayload(v);
        if (payload === undefined) throw new PayloadConverterError(`Failed to encode entry: ${k}: ${v}`);
        const [encodedPayload] = await payloadCodec.encode([payload]);
        return [k as K, encodedPayload];
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
export async function encodeFailure(_codec: PayloadCodec, failure: ProtoFailure): Promise<EncodedProtoFailure> {
  const codec = _codec as TypecheckedPayloadCodec;
  return {
    ...failure,
    cause: failure.cause ? await encodeFailure(codec, failure.cause) : null,
    applicationFailureInfo: {
      ...failure.activityFailureInfo,
      details: {
        payloads: await codec.encode(failure.applicationFailureInfo?.details?.payloads ?? []),
      },
    },
    timeoutFailureInfo: {
      ...failure.timeoutFailureInfo,
      lastHeartbeatDetails: {
        payloads: await codec.encode(failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads ?? []),
      },
    },
    canceledFailureInfo: {
      ...failure.canceledFailureInfo,
      details: {
        payloads: await codec.encode(failure.canceledFailureInfo?.details?.payloads ?? []),
      },
    },
    terminatedFailureInfo: {
      ...failure.terminatedFailureInfo,
      encoded: true,
    },
    resetWorkflowFailureInfo: {
      ...failure.resetWorkflowFailureInfo,
      lastHeartbeatDetails: {
        payloads: await codec.encode(failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads ?? []),
      },
    },
  };
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeOptionalFailure(
  codec: PayloadCodec,
  failure: ProtoFailure | null | undefined
): Promise<EncodedProtoFailure | null | undefined> {
  if (!failure) return failure;
  return await encodeFailure(codec, failure);
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

/**
 * Mark all values in the map as encoded.
 * Use this for headers and searchAttributes, which we don't encode.
 */
export function noopEncodeMap<K extends string>(
  map: Record<K, Payload> | null | undefined
): Record<K, EncodedPayload> | null | undefined {
  if (!map) return map;
  return map as Record<K, EncodedPayload>;
}
