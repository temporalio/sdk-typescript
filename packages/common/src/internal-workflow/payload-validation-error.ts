import { ApplicationFailure } from '../failure';

/**
 * The type of the {@link ApplicationFailure} reserved for payload validation failures; see
 * `createPayloadValidationError`.
 *
 * @internal
 */
export const PAYLOAD_VALIDATION_ERROR_TYPE = 'PayloadValidationError';

/**
 * Whether `error` itself is a non-retryable {@link ApplicationFailure} whose type is exactly
 * {@link PAYLOAD_VALIDATION_ERROR_TYPE}.
 *
 * @internal
 */
export function isPayloadValidationError(error: unknown): error is ApplicationFailure {
  return (
    error instanceof ApplicationFailure && error.type === PAYLOAD_VALIDATION_ERROR_TYPE && error.nonRetryable === true
  );
}
