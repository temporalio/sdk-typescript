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
} from '@temporalio/workflow-common';

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
 * Run `codec.encode()` on the {@link Payload}s in a {@link ProtoFailure}. Mutates `failure`.
 */
export async function encodeFailure(codec: PayloadCodec, failure: ProtoFailure): Promise<ProtoFailure> {
  if (failure.cause) {
    await encodeFailure(codec, failure.cause);
  }

  if (failure.applicationFailureInfo?.details?.payloads?.length) {
    failure.applicationFailureInfo.details.payloads = await codec.encode(
      failure.applicationFailureInfo.details.payloads
    );
  }
  if (failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    failure.timeoutFailureInfo.lastHeartbeatDetails.payloads = await codec.encode(
      failure.timeoutFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  if (failure.canceledFailureInfo?.details?.payloads?.length) {
    failure.canceledFailureInfo.details.payloads = await codec.encode(failure.canceledFailureInfo.details.payloads);
  }
  if (failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads = await codec.encode(
      failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  return failure;
}

/**
 * Run `codec.decode()` on the {@link Payload}s in a {@link ProtoFailure}. Mutates `failure`.
 */
export async function decodeFailure(codec: PayloadCodec, failure: ProtoFailure): Promise<ProtoFailure> {
  if (failure.cause) {
    await decodeFailure(codec, failure.cause);
  }

  if (failure.applicationFailureInfo?.details?.payloads?.length) {
    failure.applicationFailureInfo.details.payloads = await codec.decode(
      failure.applicationFailureInfo.details.payloads
    );
  }
  if (failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    failure.timeoutFailureInfo.lastHeartbeatDetails.payloads = await codec.decode(
      failure.timeoutFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  if (failure.canceledFailureInfo?.details?.payloads?.length) {
    failure.canceledFailureInfo.details.payloads = await codec.decode(failure.canceledFailureInfo.details.payloads);
  }
  if (failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads = await codec.decode(
      failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  return failure;
}
