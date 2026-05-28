import type { temporal } from '@temporalio/proto';
import type { Payload } from '../interfaces';
import {
  arrayFromPayloads,
  convertOptionalToPayload,
  fromPayloadsAtIndex,
  toPayloadsWithContext,
} from '../converter/payload-converter';
import { PayloadConverterError } from '../errors';
import type { PayloadCodec } from '../converter/payload-codec';
import type { ProtoFailure } from '../failure';
import type { LoadedDataConverter } from '../converter/data-converter';
import type { UserMetadata } from '../user-metadata';
import type { SerializationContext } from '../converter/serialization-context';
import type { DecodedPayload, DecodedProtoFailure, EncodedPayload, EncodedProtoFailure } from './codec-types';

/**
 * Decode through each codec, starting with the last codec.
 */
export async function decode(
  codecs: PayloadCodec[],
  payloads: Payload[],
  context?: SerializationContext
): Promise<DecodedPayload[]> {
  for (let i = codecs.length - 1; i >= 0; i--) {
    payloads = await codecs[i]!.decode(payloads, context);
  }
  return payloads as DecodedPayload[];
}

/**
 * Encode through each codec, starting with the first codec.
 */
export async function encode(
  codecs: PayloadCodec[],
  payloads: Payload[],
  context?: SerializationContext
): Promise<EncodedPayload[]> {
  for (let i = 0; i < codecs.length; i++) {
    payloads = await codecs[i]!.encode(payloads, context);
  }
  return payloads as EncodedPayload[];
}

/** Run {@link PayloadCodec.encode} on `payloads` */
export async function encodeOptional(
  codecs: PayloadCodec[],
  payloads: Payload[] | null | undefined,
  context?: SerializationContext
): Promise<EncodedPayload[] | null | undefined> {
  if (payloads == null) return payloads;
  return await encode(codecs, payloads, context);
}

/** Run {@link PayloadCodec.decode} on `payloads` */
export async function decodeOptional(
  codecs: PayloadCodec[],
  payloads: Payload[] | null | undefined,
  context?: SerializationContext
): Promise<DecodedPayload[] | null | undefined> {
  if (payloads == null) return payloads;
  return await decode(codecs, payloads, context);
}

async function encodeSingle(
  codecs: PayloadCodec[],
  payload: Payload,
  context?: SerializationContext
): Promise<EncodedPayload> {
  const encodedPayloads = await encode(codecs, [payload], context);
  return encodedPayloads[0] as EncodedPayload;
}

async function decodeSingle(
  codecs: PayloadCodec[],
  payload: Payload,
  context?: SerializationContext
): Promise<DecodedPayload> {
  const [decodedPayload] = await decode(codecs, [payload], context);
  return decodedPayload!;
}

/** Run {@link PayloadCodec.encode} on a single Payload */
export async function encodeOptionalSingle(
  codecs: PayloadCodec[],
  payload: Payload | null | undefined,
  context?: SerializationContext
): Promise<EncodedPayload | null | undefined> {
  if (payload == null) return payload;
  return await encodeSingle(codecs, payload, context);
}

/** Run {@link PayloadCodec.decode} on a single Payload */
export async function decodeOptionalSingle(
  codecs: PayloadCodec[],
  payload: Payload | null | undefined,
  context?: SerializationContext
): Promise<DecodedPayload | null | undefined> {
  if (payload == null) return payload;
  return await decodeSingle(codecs, payload, context);
}

/** Run {@link PayloadCodec.decode} and convert from a single Payload */
export async function decodeOptionalSinglePayload<T>(
  dataConverter: LoadedDataConverter,
  payload?: Payload | null | undefined,
  context?: SerializationContext
): Promise<T | null | undefined> {
  const { payloadConverter, payloadCodecs } = dataConverter;
  const decoded = await decodeOptionalSingle(payloadCodecs, payload, context);
  if (decoded == null) return decoded;
  return payloadConverter.fromPayload(decoded, context);
}

/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export async function encodeToPayload(
  converter: LoadedDataConverter,
  value: unknown,
  context?: SerializationContext
): Promise<Payload> {
  const { payloadConverter, payloadCodecs } = converter;
  return await encodeSingle(payloadCodecs, payloadConverter.toPayload(value, context), context);
}

/**
 * Decode `payloads` and then return {@link arrayFromPayloads}`.
 */
export async function decodeArrayFromPayloads(
  converter: LoadedDataConverter,
  payloads?: Payload[] | null,
  context?: SerializationContext
): Promise<unknown[]> {
  const { payloadConverter, payloadCodecs } = converter;
  return arrayFromPayloads(payloadConverter, await decodeOptional(payloadCodecs, payloads, context), context);
}

/**
 * Decode `payloads` and then return {@link fromPayloadsAtIndex}.
 */
export async function decodeFromPayloadsAtIndex<T>(
  converter: LoadedDataConverter,
  index: number,
  payloads?: Payload[] | null,
  context?: SerializationContext
): Promise<T> {
  const { payloadConverter, payloadCodecs } = converter;
  return await fromPayloadsAtIndex(
    payloadConverter,
    index,
    await decodeOptional(payloadCodecs, payloads, context),
    context
  );
}

/**
 * Run {@link decodeFailure} and then return {@link failureToError}.
 */
export async function decodeOptionalFailureToOptionalError(
  converter: LoadedDataConverter,
  failure: ProtoFailure | undefined | null,
  context?: SerializationContext
): Promise<Error | undefined> {
  const { failureConverter, payloadConverter, payloadCodecs } = converter;
  return failure
    ? failureConverter.failureToError(await decodeFailure(payloadCodecs, failure, context), payloadConverter, context)
    : undefined;
}

export async function decodeOptionalMap(
  codecs: PayloadCodec[],
  payloads: Record<string, Payload> | null | undefined,
  context?: SerializationContext
): Promise<Record<string, DecodedPayload> | null | undefined> {
  if (payloads == null) return payloads;
  return Object.fromEntries(
    await Promise.all(Object.entries(payloads).map(async ([k, v]) => [k, (await decode(codecs, [v], context))[0]]))
  );
}

/**
 * Run {@link PayloadConverter.toPayload} on values, and then encode them.
 */
export async function encodeToPayloads(
  converter: LoadedDataConverter,
  ...values: unknown[]
): Promise<Payload[] | undefined> {
  return encodeToPayloadsWithContext(converter, undefined, values);
}

/**
 * Run {@link PayloadConverter.toPayload} on values with an optional serialization context, and then encode them.
 */
export async function encodeToPayloadsWithContext(
  converter: LoadedDataConverter,
  context: SerializationContext | undefined,
  values: unknown[]
): Promise<Payload[] | undefined> {
  const { payloadConverter, payloadCodecs } = converter;
  if (values.length === 0) {
    return undefined;
  }
  const payloads = toPayloadsWithContext(payloadConverter, context, values);
  return payloads ? await encode(payloadCodecs, payloads, context) : undefined;
}

/**
 * Run {@link PayloadCodec.decode} and then {@link PayloadConverter.fromPayload} on values in `map`.
 */
export async function decodeMapFromPayloads<K extends string>(
  converter: LoadedDataConverter,
  map: Record<K, Payload> | null | undefined,
  context?: SerializationContext
): Promise<Record<K, unknown> | undefined> {
  if (!map) return undefined;
  const { payloadConverter, payloadCodecs } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, payload]): Promise<[K, unknown]> => {
        const [decodedPayload] = await decode(payloadCodecs, [payload as Payload], context);
        const value = payloadConverter.fromPayload(decodedPayload!, context);
        return [k as K, value];
      })
    )
  ) as Record<K, unknown>;
}

/** Run {@link PayloadCodec.encode} on all values in `map` */
export async function encodeMap<K extends string>(
  codecs: PayloadCodec[],
  map: Record<K, Payload> | null | undefined,
  context?: SerializationContext
): Promise<Record<K, EncodedPayload> | null | undefined> {
  if (map === null) return null;
  if (map === undefined) return undefined;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, payload]): Promise<[K, EncodedPayload]> => {
        return [k as K, await encodeSingle(codecs, payload as Payload, context)];
      })
    )
  ) as Record<K, EncodedPayload>;
}

/**
 * Run {@link PayloadConverter.toPayload} and then {@link PayloadCodec.encode} on values in `map`.
 */
export async function encodeMapToPayloads<K extends string>(
  converter: LoadedDataConverter,
  map: Record<K, unknown>,
  context?: SerializationContext
): Promise<Record<K, Payload>> {
  const { payloadConverter, payloadCodecs } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, v]): Promise<[K, Payload]> => {
        const payload = payloadConverter.toPayload(v, context);
        if (payload === undefined) throw new PayloadConverterError(`Failed to encode entry: ${k}: ${v}`);
        const [encodedPayload] = await encode(payloadCodecs, [payload], context);
        return [k as K, encodedPayload!];
      })
    )
  ) as Record<K, Payload>;
}

/**
 * Run {@link errorToFailure} on `error`, and then {@link encodeFailure}.
 */
export async function encodeErrorToFailure(
  dataConverter: LoadedDataConverter,
  error: unknown,
  context?: SerializationContext
): Promise<ProtoFailure> {
  const { failureConverter, payloadConverter, payloadCodecs } = dataConverter;
  return await encodeFailure(payloadCodecs, failureConverter.errorToFailure(error, payloadConverter, context), context);
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function encodeFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure,
  context?: SerializationContext
): Promise<EncodedProtoFailure> {
  return {
    ...failure,
    encodedAttributes: failure.encodedAttributes
      ? (await encode(codecs, [failure.encodedAttributes], context))[0]
      : undefined,
    cause: failure.cause ? await encodeFailure(codecs, failure.cause, context) : null,
    applicationFailureInfo: failure.applicationFailureInfo
      ? {
          ...failure.applicationFailureInfo,
          details: failure.applicationFailureInfo.details
            ? {
                payloads: await encode(codecs, failure.applicationFailureInfo.details.payloads ?? [], context),
              }
            : undefined,
        }
      : undefined,
    timeoutFailureInfo: failure.timeoutFailureInfo
      ? {
          ...failure.timeoutFailureInfo,
          lastHeartbeatDetails: failure.timeoutFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await encode(codecs, failure.timeoutFailureInfo.lastHeartbeatDetails.payloads ?? [], context),
              }
            : undefined,
        }
      : undefined,
    canceledFailureInfo: failure.canceledFailureInfo
      ? {
          ...failure.canceledFailureInfo,
          details: failure.canceledFailureInfo.details
            ? {
                payloads: await encode(codecs, failure.canceledFailureInfo.details.payloads ?? [], context),
              }
            : undefined,
        }
      : undefined,
    resetWorkflowFailureInfo: failure.resetWorkflowFailureInfo
      ? {
          ...failure.resetWorkflowFailureInfo,
          lastHeartbeatDetails: failure.resetWorkflowFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await encode(
                  codecs,
                  failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads ?? [],
                  context
                ),
              }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Return a new {@link ProtoFailure} with `codec.decode()` run on all the {@link Payload}s.
 */
export async function decodeFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure,
  context?: SerializationContext
): Promise<DecodedProtoFailure> {
  return {
    ...failure,
    encodedAttributes: failure.encodedAttributes
      ? (await decode(codecs, [failure.encodedAttributes], context))[0]
      : undefined,
    cause: failure.cause ? await decodeFailure(codecs, failure.cause, context) : null,
    applicationFailureInfo: failure.applicationFailureInfo
      ? {
          ...failure.applicationFailureInfo,
          details: failure.applicationFailureInfo.details
            ? {
                payloads: await decode(codecs, failure.applicationFailureInfo.details.payloads ?? [], context),
              }
            : undefined,
        }
      : undefined,
    timeoutFailureInfo: failure.timeoutFailureInfo
      ? {
          ...failure.timeoutFailureInfo,
          lastHeartbeatDetails: failure.timeoutFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await decode(codecs, failure.timeoutFailureInfo.lastHeartbeatDetails.payloads ?? [], context),
              }
            : undefined,
        }
      : undefined,
    canceledFailureInfo: failure.canceledFailureInfo
      ? {
          ...failure.canceledFailureInfo,
          details: failure.canceledFailureInfo.details
            ? {
                payloads: await decode(codecs, failure.canceledFailureInfo.details.payloads ?? [], context),
              }
            : undefined,
        }
      : undefined,
    resetWorkflowFailureInfo: failure.resetWorkflowFailureInfo
      ? {
          ...failure.resetWorkflowFailureInfo,
          lastHeartbeatDetails: failure.resetWorkflowFailureInfo.lastHeartbeatDetails
            ? {
                payloads: await decode(
                  codecs,
                  failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads ?? [],
                  context
                ),
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
  failure: ProtoFailure | null | undefined,
  context?: SerializationContext
): Promise<EncodedProtoFailure | null | undefined> {
  if (failure == null) return failure;
  return await encodeFailure(codecs, failure, context);
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export async function decodeOptionalFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure | null | undefined,
  context?: SerializationContext
): Promise<DecodedProtoFailure | null | undefined> {
  if (failure == null) return failure;
  return await decodeFailure(codecs, failure, context);
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

export function noopEncodeSearchAttrs(
  attrs: temporal.api.common.v1.ISearchAttributes | null | undefined
): temporal.api.common.v1.ISearchAttributes | null | undefined {
  if (!attrs) {
    return attrs;
  }
  return {
    indexedFields: noopEncodeMap(attrs.indexedFields),
  };
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
  staticDetails: string | undefined,
  context?: SerializationContext
): Promise<temporal.api.sdk.v1.IUserMetadata | undefined> {
  if (staticSummary == null && staticDetails == null) return undefined;

  const { payloadConverter, payloadCodecs } = dataConverter;
  const summary = await encodeOptionalSingle(
    payloadCodecs,
    convertOptionalToPayload(payloadConverter, staticSummary, context),
    context
  );
  const details = await encodeOptionalSingle(
    payloadCodecs,
    convertOptionalToPayload(payloadConverter, staticDetails, context),
    context
  );

  if (summary == null && details == null) return undefined;

  return { summary, details };
}

export async function decodeUserMetadata(
  dataConverter: LoadedDataConverter,
  metadata: temporal.api.sdk.v1.IUserMetadata | undefined | null,
  context?: SerializationContext
): Promise<UserMetadata> {
  const res = { staticSummary: undefined, staticDetails: undefined };
  if (metadata == null) return res;

  const staticSummary =
    (await decodeOptionalSinglePayload<string>(dataConverter, metadata.summary, context)) ?? undefined;
  const staticDetails =
    (await decodeOptionalSinglePayload<string>(dataConverter, metadata.details, context)) ?? undefined;

  return { staticSummary, staticDetails };
}
