/**
 * Codec-only helpers that operate on {@link Payload}s via {@link PayloadCodec}.
 *
 * For helpers that orchestrate the full data pipeline (converter + codec + extstore etc),
 * see `./data-pipeline-helpers`.
 *
 * @module
 */
import type { temporal } from '@temporalio/proto';
import type { Payload } from '../interfaces';
import type { PayloadCodec } from '../converter/payload-codec';
import type { ProtoFailure } from '../failure';
import type { SerializationContext } from '../converter/serialization-context';
import type {
  DecodedPayload,
  DecodedProtoFailure,
  EncodedPayload,
  EncodedProtoFailure,
  ReplaceNested,
} from './codec-types';

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

export async function encodeSingle(
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

/**
 * Walk every payload field of a {@link ProtoFailure} and apply a `transform`.
 *
 * @internal
 */
export async function transformFailurePayloads<P extends Payload>(
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
