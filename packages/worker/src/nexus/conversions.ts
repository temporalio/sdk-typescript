import { status } from '@grpc/grpc-js';
import * as protobuf from 'protobufjs';
import * as protoJsonSerializer from 'proto3-json-serializer';
import * as nexus from 'nexus-rpc';
import { temporal } from '@temporalio/proto';
import { isGrpcServiceError, ServiceError } from '@temporalio/client';
import { ApplicationFailure, LoadedDataConverter, Payload, PayloadConverter } from '@temporalio/common';
import { encodeErrorToFailure, decodeOptionalSingle } from '@temporalio/common/lib/internal-non-workflow';
import { fixBuffers } from '@temporalio/common/lib/proto-utils';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Payloads
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function decodePayloadIntoLazyValue(
  dataConverter: LoadedDataConverter,
  payload: temporal.api.common.v1.IPayload | undefined
): Promise<nexus.LazyValue> {
  let decoded: Payload | undefined | null;
  try {
    decoded = await decodeOptionalSingle(dataConverter.payloadCodecs, payload);
  } catch (err) {
    throw new nexus.HandlerError('BAD_REQUEST', `Failed to decode payload: ${err}`);
  }

  // Nexus headers have string values and Temporal Payloads have binary values. Instead of
  // converting Payload instances into Content instances, we embed the Payload in the serializer
  // and pretend we are deserializing an empty Content.
  const input = new nexus.LazyValue(new PayloadSerializer(dataConverter.payloadConverter, decoded ?? undefined), {});

  return input;
}

/**
 * An adapter from a Temporal PayloadConverer and a Nexus Serializer.
 */
class PayloadSerializer implements nexus.Serializer {
  constructor(
    readonly payloadConverter: PayloadConverter,
    readonly payload?: Payload
  ) {}

  deserialize<T>(): T {
    if (this.payload == null) {
      return undefined as T;
    }
    try {
      return this.payloadConverter.fromPayload(this.payload);
    } catch (err) {
      throw new nexus.HandlerError('BAD_REQUEST', `Failed to deserialize input: ${err}`);
    }
  }

  /** Not used in this path */
  serialize(): nexus.Content {
    throw new Error('not implemented');
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Failures
////////////////////////////////////////////////////////////////////////////////////////////////////

// fullName isn't part of the generated typed unfortunately.
const TEMPORAL_FAILURE_METADATA = { type: (temporal.api.failure.v1.Failure as any).fullName.slice(1) };

export async function operationErrorToProto(
  dataConverter: LoadedDataConverter,
  err: nexus.OperationError
): Promise<temporal.api.nexus.v1.IUnsuccessfulOperationError> {
  let { cause } = err;
  if (cause == null) {
    // Create an error without capturing a stack trace.
    const wrapped = Object.create(ApplicationFailure.prototype);
    wrapped.message = err.message;
    wrapped.stack = err.stack;
    wrapped.nonRetryable = true;
    cause = wrapped;
  }
  return {
    operationState: err.state,
    failure: await errorToNexusFailure(dataConverter, cause),
  };
}

async function errorToNexusFailure(
  dataConverter: LoadedDataConverter,
  err: unknown
): Promise<temporal.api.nexus.v1.IFailure> {
  const failure = await encodeErrorToFailure(dataConverter, err);

  const { message } = failure;
  delete failure.message;

  // TODO: there must be a more graceful way of passing this object to this function.
  const pbj = protoJsonSerializer.toProto3JSON(
    temporal.api.failure.v1.Failure.fromObject(failure) as any as protobuf.Message
  );

  return {
    message,
    metadata: TEMPORAL_FAILURE_METADATA,
    details: Buffer.from(JSON.stringify(fixBuffers(pbj))),
  };
}

export async function handlerErrorToProto(
  dataConverter: LoadedDataConverter,
  err: nexus.HandlerError
): Promise<temporal.api.nexus.v1.IHandlerError> {
  let retryBehavior: temporal.api.enums.v1.NexusHandlerErrorRetryBehavior =
    temporal.api.enums.v1.NexusHandlerErrorRetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_UNSPECIFIED;
  if (err.retryable === true) {
    retryBehavior = temporal.api.enums.v1.NexusHandlerErrorRetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_RETRYABLE;
  } else if (err.retryable === false) {
    retryBehavior =
      temporal.api.enums.v1.NexusHandlerErrorRetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_NON_RETRYABLE;
  }

  let { cause } = err;
  if (cause == null) {
    // TODO(nexus/error): I believe this is wrong, but leaving as-is until we have a decision on
    //                    on how we want to encode Nexus errors going forward.
    //
    // Create an error without capturing a stack trace.
    const wrapped = Object.create(ApplicationFailure.prototype);
    wrapped.message = err.message;
    wrapped.stack = err.stack;
    cause = wrapped;
  }

  return {
    errorType: err.type,
    failure: await errorToNexusFailure(dataConverter, cause),
    retryBehavior,
  };
}

export function coerceToHandlerError(err: unknown): nexus.HandlerError {
  if (err instanceof nexus.HandlerError) {
    return err;
  }

  // REVIEW: This check could be moved down and fold into the next one but will keep for now to help readability.
  if (err instanceof ApplicationFailure && err.nonRetryable) {
    return new nexus.HandlerError('INTERNAL', undefined, { cause: err, retryableOverride: false });
  }

  if (err instanceof ServiceError) {
    if (isGrpcServiceError(err.cause)) {
      switch (err.cause.code) {
        case status.INVALID_ARGUMENT:
          return new nexus.HandlerError('BAD_REQUEST', undefined, { cause: err });
        case (status.ALREADY_EXISTS, status.FAILED_PRECONDITION, status.OUT_OF_RANGE):
          return new nexus.HandlerError('INTERNAL', undefined, { cause: err, retryableOverride: false });
        case (status.ABORTED, status.UNAVAILABLE):
          return new nexus.HandlerError('UNAVAILABLE', undefined, { cause: err });
        case (status.CANCELLED,
        status.DATA_LOSS,
        status.INTERNAL,
        status.UNKNOWN,
        status.UNAUTHENTICATED,
        status.PERMISSION_DENIED):
          // Note that UNAUTHENTICATED and PERMISSION_DENIED have Nexus error types but we convert to internal because
          // this is not a client auth error and happens when the handler fails to auth with Temporal and should be
          // considered retryable.
          return new nexus.HandlerError('INTERNAL', undefined, { cause: err });
        case status.NOT_FOUND:
          return new nexus.HandlerError('NOT_FOUND', undefined, { cause: err });
        case status.RESOURCE_EXHAUSTED:
          return new nexus.HandlerError('RESOURCE_EXHAUSTED', undefined, { cause: err });
        case status.UNIMPLEMENTED:
          return new nexus.HandlerError('NOT_IMPLEMENTED', undefined, { cause: err });
        case status.DEADLINE_EXCEEDED:
          return new nexus.HandlerError('UPSTREAM_TIMEOUT', undefined, { cause: err });
      }
    }
  }

  return new nexus.HandlerError('INTERNAL', undefined, { cause: err });
}
