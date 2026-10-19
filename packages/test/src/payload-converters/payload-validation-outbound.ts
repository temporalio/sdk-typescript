import type { Payload, PayloadConverter, SerializationContext } from '@temporalio/common';
import { ApplicationFailure, createPayloadValidationError, defaultPayloadConverter } from '@temporalio/common';

/** Values containing this string are rejected with an exact (non-retryable) PayloadValidationError. */
export const PVE_MARKER = '__payload_validation_outbound_marker__';

/** Values containing this string are rejected with an error whose cause is an exact PayloadValidationError. */

/**
 * Values containing this string are rejected with an exact PayloadValidationError whose details
 * contain this string, so that the converter also rejects the details.
 */
export const SELF_REJECTING_PVE_MARKER = '__payload_validation_self_rejecting_marker__';

/** Values containing this string are rejected with an error unrelated to payload validation. */
export const UNRELATED_ERROR_MARKER = '__payload_validation_unrelated_error_marker__';

/** Values containing this string are rejected with a retryable failure that merely has the PVE type. */
export const RETRYABLE_LOOKALIKE_MARKER = '__payload_validation_retryable_lookalike_marker__';

function contains(value: unknown, marker: string): boolean {
  try {
    return JSON.stringify(value)?.includes(marker) ?? false;
  } catch {
    return false;
  }
}

/**
 * A marker-selective payload converter, simulating a validating converter that rejects some
 * payloads produced by Workflow code. Only `toPayload` is affected, so that inputs produced by
 * a client using the default converter are accepted.
 */
export const payloadConverter: PayloadConverter = {
  toPayload<T>(value: T, context?: SerializationContext): Payload {
    if (contains(value, SELF_REJECTING_PVE_MARKER)) {
      throw createPayloadValidationError({ reason: SELF_REJECTING_PVE_MARKER });
    }
    if (contains(value, UNRELATED_ERROR_MARKER)) {
      throw new Error('Unrelated converter failure');
    }
    if (contains(value, PVE_MARKER)) {
      throw createPayloadValidationError({ reason: 'outbound payload rejected by test converter' });
    }
    if (contains(value, RETRYABLE_LOOKALIKE_MARKER)) {
      throw ApplicationFailure.retryable('Payload validation failed', 'PayloadValidationError');
    }
    return defaultPayloadConverter.toPayload(value, context);
  },
  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    return defaultPayloadConverter.fromPayload(payload, context);
  },
};
