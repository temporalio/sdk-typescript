import {
  arrayFromPayloads,
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
import { DecodedPayload, DecodedProtoFailure, EncodedPayload, EncodedProtoFailure } from './codec-types';

/**
 * Decode through each codec, starting with the last codec.
 */
export async function decode(codecs: PayloadCodec[], payloads: Payload[]): Promise<DecodedPayload[]> {
  for (let i = codecs.length - 1; i >= 0; i--) {
    payloads = await codecs[i].decode(payloads);
  }
  return payloads as DecodedPayload[];
}

export async function encode(codecs: PayloadCodec[], payloads: Payload[]): Promise<EncodedPayload[]> {
  for (let i = 0; i < codecs.length; i++) {
    payloads = await codecs[i].encode(payloads);
  }
  return payloads as EncodedPayload[];
}

/**
 * Decode `payloads` and then return {@link fromPayloadsAtIndex}.
 */
export async function decodeFromPayloadsAtIndex<T>(
  converter: LoadedDataConverter,
  index: number,
  payloads?: Payload[] | null
): Promise<T> {
  const { payloadConverter, payloadCodecs } = converter;
  return fromPayloadsAtIndex(payloadConverter, index, payloads ? await decode(payloadCodecs, payloads) : payloads);
}

/**
 * Decode `payloads` and then return {@link arrayFromPayloads}`.
 */
export async function decodeArrayFromPayloads(
  converter: LoadedDataConverter,
  payloads?: Payload[] | null
): Promise<unknown[]> {
  const { payloadConverter, payloadCodecs } = converter;
  let decodedPayloads = payloads;
  if (payloads) {
    decodedPayloads = await decode(payloadCodecs, payloads);
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
  const { payloadConverter, payloadCodecs } = converter;
  return failure ? failureToError(await decodeFailure(payloadCodecs, failure), payloadConverter) : undefined;
}

/** Run {@link PayloadCodec.encode} on `payloads` */
export async function encodeOptional(
  codecs: PayloadCodec[],
  payloads: Payload[] | null | undefined
): Promise<EncodedPayload[] | null | undefined> {
  if (payloads === null) return null;
  if (payloads === undefined) return undefined;
  return (await encode(codecs, payloads)) as EncodedPayload[];
}

/** Run {@link PayloadCodec.decode} on `payloads` */
export async function decodeOptional(
  codecs: PayloadCodec[],
  payloads: Payload[] | null | undefined
): Promise<DecodedPayload[] | null | undefined> {
  if (payloads === null) return null;
  if (payloads === undefined) return undefined;
  return (await decode(codecs, payloads)) as DecodedPayload[];
}

async function encodeSingle(codecs: PayloadCodec[], payload: Payload): Promise<EncodedPayload> {
  const encodedPayloads = await encode(codecs, [payload]);
  return encodedPayloads[0] as EncodedPayload;
}

/** Run {@link PayloadCodec.encode} on a single Payload */
export async function encodeOptionalSingle(
  codecs: PayloadCodec[],
  payload: Payload | null | undefined
): Promise<EncodedPayload | null | undefined> {
  if (payload === null) return null;
  if (payload === undefined) return undefined;
  return await encodeSingle(codecs, payload);
}

async function decodeSingle(codecs: PayloadCodec[], payload: Payload): Promise<DecodedPayload> {
  const decodedPayloads = await decode(codecs, [payload]);
  return decodedPayloads[0] as DecodedPayload;
}

export async function decodeOptionalMap(
  codecs: PayloadCodec[],
  payloads: Record<string, Payload> | null | undefined
): Promise<Record<string, DecodedPayload> | null | undefined> {
  if (payloads === null) return null;
  if (payloads === undefined) return undefined;
  return Object.fromEntries(
    await Promise.all(Object.entries(payloads).map(async ([k, v]) => [k, await decode(codecs, [v])]))
  );
}

/** Run {@link PayloadCodec.decode} on a single Payload */
export async function decodeOptionalSingle(
  codecs: PayloadCodec[],
  payload: Payload | null | undefined
): Promise<DecodedPayload | null | undefined> {
  if (payload === null) return null;
  if (payload === undefined) return undefined;

  return await decodeSingle(codecs, payload);
}

/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export async function encodeToPayload(converter: LoadedDataConverter, value: unknown): Promise<Payload> {
  const { payloadConverter, payloadCodecs } = converter;
  return await encodeSingle(payloadCodecs, toPayload(payloadConverter, value));
}

/**
 * Run {@link PayloadConverter.toPayload} on values, and then encode them.
 */
export async function encodeToPayloads(
  converter: LoadedDataConverter,
  ...values: unknown[]
): Promise<Payload[] | undefined> {
  const { payloadConverter, payloadCodecs } = converter;
  if (values.length === 0) {
    return undefined;
  }
  const payloads = toPayloads(payloadConverter, ...values);
  return payloads ? await encode(payloadCodecs, payloads) : undefined;
}

/**
 * Run {@link PayloadCodec.decode} and then {@link PayloadConverter.fromPayload} on values in `map`.
 */
export async function decodeMapFromPayloads<K extends string>(
  converter: LoadedDataConverter,
  map: Record<K, Payload> | null | undefined
): Promise<Record<K, unknown> | undefined> {
  if (!map) return undefined;
  const { payloadConverter, payloadCodecs } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, payload]): Promise<[K, unknown]> => {
        const [decodedPayload] = await decode(payloadCodecs, [payload as Payload]);
        const value = payloadConverter.fromPayload(decodedPayload);
        return [k as K, value];
      })
    )
  ) as Record<K, unknown>;
}

/** Run {@link PayloadCodec.encode} on all values in `map` */
export async function encodeMap<K extends string>(
  codecs: PayloadCodec[],
  map: Record<K, Payload> | null | undefined
): Promise<Record<K, EncodedPayload> | null | undefined> {
  if (map === null) return null;
  if (map === undefined) return undefined;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, payload]): Promise<[K, EncodedPayload]> => {
        return [k as K, await encodeSingle(codecs, payload as Payload)];
      })
    )
  ) as Record<K, EncodedPayload>;
}

/**
 * Run {@link PayloadConverter.toPayload} and then {@link PayloadCodec.encode} on values in `map`.
 */
export async function encodeMapToPayloads<K extends string>(
  converter: LoadedDataConverter,
  map: Record<K, unknown>
): Promise<Record<K, Payload>> {
  const { payloadConverter, payloadCodecs } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, v]): Promise<[K, Payload]> => {
        const payload = toPayload(payloadConverter, v);
        if (payload === undefined) throw new PayloadConverterError(`Failed to encode entry: ${k}: ${v}`);
        const [encodedPayload] = await encode(payloadCodecs, [payload]);
        return [k as K, encodedPayload];
      })
    )
  ) as Record<K, Payload>;
}

/**
 * Run {@link errorToFailure} on `error`, and then {@link encodeFailure}.
 */
export async function encodeErrorToFailure(dataConverter: LoadedDataConverter, error: unknown): Promise<ProtoFailure> {
  const { payloadConverter, payloadCodecs } = dataConverter;
  return await encodeFailure(payloadCodecs, errorToFailure(error, payloadConverter));
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeFailure(codecs: PayloadCodec[], failure: ProtoFailure): Promise<EncodedProtoFailure> {
  return {
    ...failure,
    cause: failure.cause ? await encodeFailure(codecs, failure.cause) : null,
    applicationFailureInfo: failure.applicationFailureInfo
      ? {
          ...failure.applicationFailureInfo,
          details: failure.applicationFailureInfo.details
            ? {
                payloads: await encode(codecs, failure.applicationFailureInfo.details.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
    timeoutFailureInfo: failure.timeoutFailureInfo
      ? {
          ...failure.timeoutFailureInfo,
          lastHeartbeatDetails: failure.timeoutFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await encode(codecs, failure.timeoutFailureInfo.lastHeartbeatDetails.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
    canceledFailureInfo: failure.canceledFailureInfo
      ? {
          ...failure.canceledFailureInfo,
          details: failure.canceledFailureInfo.details
            ? {
                payloads: await encode(codecs, failure.canceledFailureInfo.details.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
    resetWorkflowFailureInfo: failure.resetWorkflowFailureInfo
      ? {
          ...failure.resetWorkflowFailureInfo,
          lastHeartbeatDetails: failure.resetWorkflowFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await encode(codecs, failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeOptionalFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure | null | undefined
): Promise<EncodedProtoFailure | null | undefined> {
  if (failure === null) return null;
  if (failure === undefined) return undefined;
  return await encodeFailure(codecs, failure);
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function decodeOptionalFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure | null | undefined
): Promise<DecodedProtoFailure | null | undefined> {
  if (failure === null) return null;
  if (failure === undefined) return undefined;
  return await decodeFailure(codecs, failure);
}

/**
 * Return a new {@link ProtoFailure} with `codec.decode()` run on all the {@link Payload}s.
 */
export async function decodeFailure(codecs: PayloadCodec[], failure: ProtoFailure): Promise<DecodedProtoFailure> {
  return {
    ...failure,
    cause: failure.cause ? await decodeFailure(codecs, failure.cause) : null,
    applicationFailureInfo: failure.applicationFailureInfo
      ? {
          ...failure.applicationFailureInfo,
          details: failure.applicationFailureInfo.details
            ? {
                payloads: await decode(codecs, failure.applicationFailureInfo.details.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
    timeoutFailureInfo: failure.timeoutFailureInfo
      ? {
          ...failure.timeoutFailureInfo,
          lastHeartbeatDetails: failure.timeoutFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await decode(codecs, failure.timeoutFailureInfo.lastHeartbeatDetails.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
    canceledFailureInfo: failure.canceledFailureInfo
      ? {
          ...failure.canceledFailureInfo,
          details: failure.canceledFailureInfo.details
            ? {
                payloads: await decode(codecs, failure.canceledFailureInfo.details.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
    resetWorkflowFailureInfo: failure.resetWorkflowFailureInfo
      ? {
          ...failure.resetWorkflowFailureInfo,
          lastHeartbeatDetails: failure.resetWorkflowFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await decode(codecs, failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads ?? []),
              }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Mark all values in the map as encoded.
 * Use this for headers and searchAttributes, which we don't encode.
 */
export function noopEncodeMap<K extends string>(
  map: Record<K, Payload> | null | undefined
): Record<K, EncodedPayload> | null | undefined {
  if (map === null) return null;
  if (map === undefined) return undefined;
  return map as Record<K, EncodedPayload>;
}

/**
 * Mark all values in the map as decoded.
 * Use this for headers and searchAttributes, which we don't encode.
 */
export function noopDecodeMap<K extends string>(
  map: Record<K, Payload> | null | undefined
): Record<K, DecodedPayload> | null | undefined {
  if (map === null) return null;
  if (map === undefined) return undefined;
  return map as Record<K, DecodedPayload>;
}
