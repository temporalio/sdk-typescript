import type { temporal } from '@temporalio/proto';
import { Payload } from '../interfaces';
import {
  arrayFromPayloads,
  convertOptionalToPayload,
  fromPayloadsAtIndex,
  toPayloads,
} from '../converter/payload-converter';
import { PayloadConverterError } from '../errors';
import { PayloadCodec } from '../converter/payload-codec';
import { ProtoFailure } from '../failure';
import { LoadedDataConverter } from '../converter/data-converter';
import { UserMetadata } from '../user-metadata';
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

/**
 * Encode through each codec, starting with the first codec.
 */
export async function encode(codecs: PayloadCodec[], payloads: Payload[]): Promise<EncodedPayload[]> {
  for (let i = 0; i < codecs.length; i++) {
    payloads = await codecs[i].encode(payloads);
  }
  return payloads as EncodedPayload[];
}

/** Run {@link PayloadCodec.encode} on `payloads` */
export async function encodeOptional(
  codecs: PayloadCodec[],
  payloads: Payload[] | null | undefined
): Promise<EncodedPayload[] | null | undefined> {
  if (payloads == null) return payloads;
  return await encode(codecs, payloads);
}

/** Run {@link PayloadCodec.decode} on `payloads` */
export async function decodeOptional(
  codecs: PayloadCodec[],
  payloads: Payload[] | null | undefined
): Promise<DecodedPayload[] | null | undefined> {
  if (payloads == null) return payloads;
  return await decode(codecs, payloads);
}

async function encodeSingle(codecs: PayloadCodec[], payload: Payload): Promise<EncodedPayload> {
  const encodedPayloads = await encode(codecs, [payload]);
  return encodedPayloads[0] as EncodedPayload;
}

async function decodeSingle(codecs: PayloadCodec[], payload: Payload): Promise<DecodedPayload> {
  const [decodedPayload] = await decode(codecs, [payload]);
  return decodedPayload;
}

/** Run {@link PayloadCodec.encode} on a single Payload */
export async function encodeOptionalSingle(
  codecs: PayloadCodec[],
  payload: Payload | null | undefined
): Promise<EncodedPayload | null | undefined> {
  if (payload == null) return payload;
  return await encodeSingle(codecs, payload);
}

/** Run {@link PayloadCodec.decode} on a single Payload */
export async function decodeOptionalSingle(
  codecs: PayloadCodec[],
  payload: Payload | null | undefined
): Promise<DecodedPayload | null | undefined> {
  if (payload == null) return payload;
  return await decodeSingle(codecs, payload);
}

/** Run {@link PayloadCodec.decode} and convert from a single Payload */
export async function decodeOptionalSinglePayload<T>(
  dataConverter: LoadedDataConverter,
  payload?: Payload | null | undefined
): Promise<T | null | undefined> {
  const { payloadConverter, payloadCodecs } = dataConverter;
  const decoded = await decodeOptionalSingle(payloadCodecs, payload);
  if (decoded == null) return decoded;
  return payloadConverter.fromPayload(decoded);
}

/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export async function encodeToPayload(converter: LoadedDataConverter, value: unknown): Promise<Payload> {
  const { payloadConverter, payloadCodecs } = converter;
  return await encodeSingle(payloadCodecs, payloadConverter.toPayload(value));
}

/**
 * Decode `payloads` and then return {@link arrayFromPayloads}`.
 */
export async function decodeArrayFromPayloads(
  converter: LoadedDataConverter,
  payloads?: Payload[] | null
): Promise<unknown[]> {
  const { payloadConverter, payloadCodecs } = converter;
  return arrayFromPayloads(payloadConverter, await decodeOptional(payloadCodecs, payloads));
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
  return await fromPayloadsAtIndex(payloadConverter, index, await decodeOptional(payloadCodecs, payloads));
}

/**
 * Run {@link decodeFailure} and then return {@link failureToError}.
 */
export async function decodeOptionalFailureToOptionalError(
  converter: LoadedDataConverter,
  failure: ProtoFailure | undefined | null
): Promise<Error | undefined> {
  const { failureConverter, payloadConverter, payloadCodecs } = converter;
  return failure
    ? failureConverter.failureToError(await decodeFailure(payloadCodecs, failure), payloadConverter)
    : undefined;
}

export async function decodeOptionalMap(
  codecs: PayloadCodec[],
  payloads: Record<string, Payload> | null | undefined
): Promise<Record<string, DecodedPayload> | null | undefined> {
  if (payloads == null) return payloads;
  return Object.fromEntries(
    await Promise.all(Object.entries(payloads).map(async ([k, v]) => [k, (await decode(codecs, [v]))[0]]))
  );
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
        const payload = payloadConverter.toPayload(v);
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
  const { failureConverter, payloadConverter, payloadCodecs } = dataConverter;
  return await encodeFailure(payloadCodecs, failureConverter.errorToFailure(error, payloadConverter));
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeFailure(codecs: PayloadCodec[], failure: ProtoFailure): Promise<EncodedProtoFailure> {
  return {
    ...failure,
    encodedAttributes: failure.encodedAttributes ? (await encode(codecs, [failure.encodedAttributes]))[0] : undefined,
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
 * Return a new {@link ProtoFailure} with `codec.decode()` run on all the {@link Payload}s.
 */
export async function decodeFailure(codecs: PayloadCodec[], failure: ProtoFailure): Promise<DecodedProtoFailure> {
  return {
    ...failure,
    encodedAttributes: failure.encodedAttributes ? (await decode(codecs, [failure.encodedAttributes]))[0] : undefined,
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
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeOptionalFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure | null | undefined
): Promise<EncodedProtoFailure | null | undefined> {
  if (failure == null) return failure;
  return await encodeFailure(codecs, failure);
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function decodeOptionalFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure | null | undefined
): Promise<DecodedProtoFailure | null | undefined> {
  if (failure == null) return failure;
  return await decodeFailure(codecs, failure);
}

/**
 * Mark all values in the map as encoded.
 * Use this for headers, which we don't encode.
 */
export function noopEncodeMap<K extends string>(
  map: Record<K, Payload> | null | undefined
): Record<K, EncodedPayload> | null | undefined {
  return map as Record<K, EncodedPayload> | null | undefined;
}

/**
 * Mark all values in the map as decoded.
 * Use this for headers, which we don't encode.
 */
export function noopDecodeMap<K extends string>(
  map: Record<K, Payload> | null | undefined
): Record<K, DecodedPayload> | null | undefined {
  return map as Record<K, DecodedPayload> | null | undefined;
}

export async function encodeUserMetadata(
  dataConverter: LoadedDataConverter,
  staticSummary: string | undefined,
  staticDetails: string | undefined
): Promise<temporal.api.sdk.v1.IUserMetadata | undefined> {
  if (staticSummary == null && staticDetails == null) return undefined;

  const { payloadConverter, payloadCodecs } = dataConverter;
  const summary = await encodeOptionalSingle(payloadCodecs, convertOptionalToPayload(payloadConverter, staticSummary));
  const details = await encodeOptionalSingle(payloadCodecs, convertOptionalToPayload(payloadConverter, staticDetails));

  if (summary == null && details == null) return undefined;

  return { summary, details };
}

export async function decodeUserMetadata(
  dataConverter: LoadedDataConverter,
  metadata: temporal.api.sdk.v1.IUserMetadata | undefined | null
): Promise<UserMetadata> {
  const res = { staticSummary: undefined, staticDetails: undefined };
  if (metadata == null) return res;

  const staticSummary = (await decodeOptionalSinglePayload<string>(dataConverter, metadata.summary)) ?? undefined;
  const staticDetails = (await decodeOptionalSinglePayload<string>(dataConverter, metadata.details)) ?? undefined;

  return { staticSummary, staticDetails };
}
