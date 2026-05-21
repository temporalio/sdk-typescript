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
import type {
  DecodedPayload,
  DecodedProtoFailure,
  EncodedPayload,
  EncodedProtoFailure,
  ReplaceNested,
} from './codec-types';
import { runExternalRetrieve, runExternalStore } from './external-storage-runner';

/** A `ProtoFailure` whose nested {@link Payload} fields all have type `P`. */
type FailureWithPayloads<P extends Payload> = ReplaceNested<ProtoFailure, Payload, P>;

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
  if (payload == null) return payload;
  const { payloadConverter, payloadCodecs, externalStorage } = dataConverter;
  const [retrievedPayload] = await runExternalRetrieve({ externalStorage, payloads: [payload] });
  const decodedPayload = await decodeOptionalSingle(payloadCodecs, retrievedPayload, context);
  if (decodedPayload == null) return decodedPayload;
  return payloadConverter.fromPayload(decodedPayload, context);
}

/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export async function encodeToPayload(
  converter: LoadedDataConverter,
  value: unknown,
  context?: SerializationContext
): Promise<Payload> {
  const { payloadConverter, payloadCodecs, externalStorage } = converter;
  const encodedPayload = await encodeSingle(payloadCodecs, payloadConverter.toPayload(value, context), context);
  const [storedPayload] = await runExternalStore({ externalStorage, context, payloads: [encodedPayload] });
  return storedPayload!;
}

/**
 * Decode `payloads` and then return {@link arrayFromPayloads}`.
 */
export async function decodeArrayFromPayloads(
  converter: LoadedDataConverter,
  payloads?: Payload[] | null,
  context?: SerializationContext
): Promise<unknown[]> {
  const { payloadConverter, payloadCodecs, externalStorage } = converter;
  const retrievedPayloads = payloads != null ? await runExternalRetrieve({ externalStorage, payloads }) : payloads;
  return arrayFromPayloads(payloadConverter, await decodeOptional(payloadCodecs, retrievedPayloads, context), context);
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
  const { payloadConverter, payloadCodecs, externalStorage } = converter;
  const retrievedPayloads = payloads != null ? await runExternalRetrieve({ externalStorage, payloads }) : payloads;
  return await fromPayloadsAtIndex(
    payloadConverter,
    index,
    await decodeOptional(payloadCodecs, retrievedPayloads, context),
    context
  );
}

/**
 * Run extstore retrieve and codec decode over every payload field of a
 * {@link ProtoFailure}, then convert the result to an {@link Error}.
 */
export async function decodeOptionalFailureToOptionalError(
  converter: LoadedDataConverter,
  failure: ProtoFailure | undefined | null,
  context?: SerializationContext
): Promise<Error | undefined> {
  if (!failure) return undefined;
  const { failureConverter, payloadConverter, payloadCodecs, externalStorage } = converter;
  const decoded = await transformFailurePayloads(failure, async (payloads) => {
    const retrieved = await runExternalRetrieve({ externalStorage, payloads });
    return decode(payloadCodecs, retrieved, context);
  });
  return failureConverter.failureToError(decoded, payloadConverter, context);
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
  const { payloadConverter, payloadCodecs, externalStorage } = converter;
  if (values.length === 0) {
    return undefined;
  }
  const payloads = toPayloadsWithContext(payloadConverter, context, values);
  if (!payloads) return undefined;
  const encoded = await encode(payloadCodecs, payloads, context);
  return await runExternalStore({ externalStorage, context, payloads: encoded });
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
  const { payloadConverter, payloadCodecs, externalStorage } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, payload]): Promise<[K, unknown]> => {
        const [retrieved] = await runExternalRetrieve({ externalStorage, payloads: [payload as Payload] });
        const [decodedPayload] = await decode(payloadCodecs, [retrieved!], context);
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
  const { payloadConverter, payloadCodecs, externalStorage } = converter;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(map).map(async ([k, v]): Promise<[K, Payload]> => {
        const payload = payloadConverter.toPayload(v, context);
        if (payload === undefined) throw new PayloadConverterError(`Failed to encode entry: ${k}: ${v}`);
        const [encodedPayload] = await encode(payloadCodecs, [payload], context);
        const [storedPayload] = await runExternalStore({ externalStorage, context, payloads: [encodedPayload!] });
        return [k as K, storedPayload!];
      })
    )
  ) as Record<K, Payload>;
}

/**
 * Convert `error` to a {@link ProtoFailure}, then run codec encode + extstore
 * store over every payload.
 */
export async function encodeErrorToFailure(
  dataConverter: LoadedDataConverter,
  error: unknown,
  context?: SerializationContext
): Promise<ProtoFailure> {
  const { failureConverter, payloadConverter, payloadCodecs, externalStorage } = dataConverter;
  const raw = failureConverter.errorToFailure(error, payloadConverter, context);
  return await transformFailurePayloads(raw, async (payloads) => {
    const encoded = await encode(payloadCodecs, payloads, context);
    return runExternalStore({ externalStorage, context, payloads: encoded });
  });
}

/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the
 * {@link Payload}s.
 */
export async function encodeFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure,
  context?: SerializationContext
): Promise<EncodedProtoFailure> {
  return await transformFailurePayloads(failure, (payloads) => encode(codecs, payloads, context));
}

/**
 * Return a new {@link ProtoFailure} with `codec.decode()` run on all the
 * {@link Payload}s.
 */
export async function decodeFailure(
  codecs: PayloadCodec[],
  failure: ProtoFailure,
  context?: SerializationContext
): Promise<DecodedProtoFailure> {
  return await transformFailurePayloads(failure, (payloads) => decode(codecs, payloads, context));
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

  const { payloadConverter, payloadCodecs, externalStorage } = dataConverter;
  const encodedSummary = await encodeOptionalSingle(
    payloadCodecs,
    convertOptionalToPayload(payloadConverter, staticSummary, context),
    context
  );
  const encodedDetails = await encodeOptionalSingle(
    payloadCodecs,
    convertOptionalToPayload(payloadConverter, staticDetails, context),
    context
  );

  if (encodedSummary == null && encodedDetails == null) return undefined;

  const store = async (p: Payload | null | undefined) =>
    p != null ? (await runExternalStore({ externalStorage, context, payloads: [p] }))[0] : undefined;
  const [summary, details] = await Promise.all([store(encodedSummary), store(encodedDetails)]);
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

/**
 * Walk every payload field of a {@link ProtoFailure} and apply a `transform`.
 */
async function transformFailurePayloads<P extends Payload>(
  failure: ProtoFailure,
  transform: (payloads: Payload[]) => Promise<P[]>
): Promise<FailureWithPayloads<P>> {
  const transformAttributes = async (p: Payload | null | undefined): Promise<P | undefined> => {
    if (!p) return undefined;
    return (await transform([p]))[0];
  };

  const result = {
    ...failure,
    encodedAttributes: await transformAttributes(failure.encodedAttributes),
    cause: failure.cause ? await transformFailurePayloads(failure.cause, transform) : null,
    applicationFailureInfo: failure.applicationFailureInfo
      ? {
          ...failure.applicationFailureInfo,
          details: failure.applicationFailureInfo.details
            ? { payloads: await transform(failure.applicationFailureInfo.details.payloads ?? []) }
            : undefined,
        }
      : undefined,
    timeoutFailureInfo: failure.timeoutFailureInfo
      ? {
          ...failure.timeoutFailureInfo,
          lastHeartbeatDetails: failure.timeoutFailureInfo.lastHeartbeatDetails
            ? { payloads: await transform(failure.timeoutFailureInfo.lastHeartbeatDetails.payloads ?? []) }
            : undefined,
        }
      : undefined,
    canceledFailureInfo: failure.canceledFailureInfo
      ? {
          ...failure.canceledFailureInfo,
          details: failure.canceledFailureInfo.details
            ? { payloads: await transform(failure.canceledFailureInfo.details.payloads ?? []) }
            : undefined,
        }
      : undefined,
    resetWorkflowFailureInfo: failure.resetWorkflowFailureInfo
      ? {
          ...failure.resetWorkflowFailureInfo,
          lastHeartbeatDetails: failure.resetWorkflowFailureInfo.lastHeartbeatDetails
            ? { payloads: await transform(failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads ?? []) }
            : undefined,
        }
      : undefined,
  };
  
  return result as FailureWithPayloads<P>;
}
