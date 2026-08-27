import { status } from '@grpc/grpc-js';
import * as nexus from 'nexus-rpc';
import { isGrpcServiceError, ServiceError } from '@temporalio/client';
import type { LoadedDataConverter, Payload, ProtoFailure, TypeInfo } from '@temporalio/common';
import { ApplicationFailure, CancelledFailure, fromPayloadWithTypeInfo } from '@temporalio/common';
import {
  encodeErrorToFailure,
  decodeOptionalSingle,
  encodeToPayload,
} from '@temporalio/common/lib/internal-non-workflow';
import {
  findPayloadValidationError,
  payloadFreePayloadValidationFailure,
} from '@temporalio/common/lib/internal-workflow/payload-validation-error';
import type { temporal } from '@temporalio/proto';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Payloads
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Error type used by a Payload Converter or Payload Codec to report that a Payload failed
 * validation, i.e. that the input is invalid rather than that the handler failed to process it.
 *
 * When a Nexus operation's input fails to decode with a non-retryable {@link ApplicationFailure} of
 * this type, the resulting Nexus Handler Error is `BAD_REQUEST` rather than `INTERNAL`.
 */
export const PAYLOAD_VALIDATION_ERROR_TYPE = 'PayloadValidationError';

/** Decode Payload Codecs and apply optional TypeInfo while translating invalid Nexus input errors. */
export async function decodePayload(
  dataConverter: LoadedDataConverter,
  payload: temporal.api.common.v1.IPayload | undefined,
  typeInfo?: TypeInfo
): Promise<unknown> {
  let decoded: Payload | undefined | null;
  try {
    decoded = await decodeOptionalSingle(dataConverter.payloadCodecs, payload);
  } catch (err) {
    const payloadValidationError = findPayloadValidationError(err);
    if (payloadValidationError !== undefined) {
      throw new nexus.HandlerError('BAD_REQUEST', `Invalid operation input`, {
        cause: payloadValidationError,
      });
    }
    if (err instanceof ApplicationFailure || err instanceof nexus.HandlerError) {
      throw err;
    }
    throw new nexus.HandlerError('INTERNAL', `Payload codec failed to decode Nexus operation input`, { cause: err });
  }

  if (decoded == null) {
    return undefined;
  }

  try {
    return fromPayloadWithTypeInfo(dataConverter.payloadConverter, decoded, undefined, typeInfo);
  } catch (err) {
    const payloadValidationError = findPayloadValidationError(err);
    if (payloadValidationError !== undefined) {
      throw new nexus.HandlerError('BAD_REQUEST', `Invalid operation input`, {
        cause: payloadValidationError,
      });
    }
    if (err instanceof ApplicationFailure || err instanceof nexus.HandlerError) {
      throw err;
    }
    throw new nexus.HandlerError('BAD_REQUEST', `Payload converter failed to decode Nexus operation input`, {
      cause: err,
    });
  }
}

/** Encode a Nexus handler result while preserving the retryable output-validation contract. */
export async function encodeNexusResult(
  dataConverter: LoadedDataConverter,
  value: unknown,
  typeInfo?: TypeInfo
): Promise<Payload> {
  try {
    return await encodeToPayload(dataConverter, value, undefined, typeInfo);
  } catch (error) {
    const payloadValidationError = findPayloadValidationError(error);
    if (payloadValidationError === undefined) throw error;
    throw new nexus.HandlerError('INTERNAL', undefined, {
      cause: payloadValidationError,
      retryableOverride: true,
    });
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Failures
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function operationErrorToProto(
  dataConverter: LoadedDataConverter,
  err: nexus.OperationError
): Promise<ProtoFailure> {
  let newError: Error;
  if (err.state === 'canceled') {
    newError = new CancelledFailure(err.message, undefined, err.cause);
  } else {
    newError = ApplicationFailure.create({
      message: err.message,
      type: 'OperationError',
      nonRetryable: true,
      cause: err.cause,
    });
  }
  newError.stack = err.stack;
  return await encodeErrorToFailure(dataConverter, newError);
}

export async function handlerErrorToProto(
  dataConverter: LoadedDataConverter,
  err: nexus.HandlerError
): Promise<ProtoFailure> {
  try {
    return await encodeErrorToFailure(dataConverter, err);
  } catch (conversionError) {
    const payloadValidationError = findPayloadValidationError(err);
    if (payloadValidationError === undefined) throw conversionError;
    return {
      message: err.message,
      stackTrace: err.stack,
      cause: payloadFreePayloadValidationFailure(payloadValidationError),
      nexusHandlerFailureInfo: {
        type: err.type,
        // NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_RETRYABLE / NON_RETRYABLE
        retryBehavior: err.retryable ? 1 : 2,
      },
    };
  }
}

export function coerceToHandlerError(err: unknown): nexus.HandlerError {
  if (err instanceof nexus.HandlerError) {
    return err;
  }

  // REVIEW: This check could be moved down and fold into the next one but will keep for now to help readability.
  if (err instanceof ApplicationFailure && err.nonRetryable) {
    return new nexus.HandlerError('INTERNAL', 'Handler failed with non-retryable application error', {
      cause: err,
      retryableOverride: false,
    });
  }

  if (err instanceof ServiceError) {
    if (isGrpcServiceError(err.cause)) {
      switch (err.cause.code) {
        case status.INVALID_ARGUMENT:
          return new nexus.HandlerError('BAD_REQUEST', undefined, { cause: err });
        case status.ALREADY_EXISTS:
        case status.FAILED_PRECONDITION:
        case status.OUT_OF_RANGE:
          return new nexus.HandlerError('INTERNAL', undefined, { cause: err, retryableOverride: false });
        case status.ABORTED:
        case status.UNAVAILABLE:
          return new nexus.HandlerError('UNAVAILABLE', undefined, { cause: err });
        case status.CANCELLED:
        case status.DATA_LOSS:
        case status.INTERNAL:
        case status.UNKNOWN:
        case status.UNAUTHENTICATED:
        case status.PERMISSION_DENIED:
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
