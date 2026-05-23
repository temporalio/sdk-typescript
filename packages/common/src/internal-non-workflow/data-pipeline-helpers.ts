/**
 * Helpers that orchestrate the full data pipeline (PayloadConverter +
 * PayloadCodec + extstore etc.).
 *
 * For codec-only helpers (i.e. just PayloadCodec), see
 * `./codec-helpers`.
 *
 * @module
 */
import type { temporal } from '@temporalio/proto';
import {
  arrayFromPayloads,
  convertOptionalToPayload,
  fromPayloadsAtIndex,
  toPayloadsWithContext,
} from '../converter/payload-converter';
import { storageTargetFromContext } from '../converter/extstore';
import { PayloadConverterError } from '../errors';
import type { LoadedDataConverter } from '../converter/data-converter';
import type { ProtoFailure } from '../failure';
import type { Payload } from '../interfaces';
import type { SerializationContext } from '../converter/serialization-context';
import type { UserMetadata } from '../user-metadata';
import {
  decode,
  decodeOptional,
  decodeOptionalSingle,
  encode,
  encodeOptionalSingle,
  encodeSingle,
  transformFailurePayloads,
} from './codec-helpers';
import { runExternalRetrieve, runExternalStore } from './external-storage-runner';

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
  const [storedPayload] = await runExternalStore({
    externalStorage,
    target: storageTargetFromContext(context),
    payloads: [encodedPayload],
  });
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
  return await runExternalStore({
    externalStorage,
    target: storageTargetFromContext(context),
    payloads: encoded,
  });
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
        const [storedPayload] = await runExternalStore({
          externalStorage,
          target: storageTargetFromContext(context),
          payloads: [encodedPayload!],
        });
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
    return runExternalStore({ externalStorage, target: storageTargetFromContext(context), payloads: encoded });
  });
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
    p != null
      ? (await runExternalStore({ externalStorage, target: storageTargetFromContext(context), payloads: [p] }))[0]
      : undefined;
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
