import { ApplicationFailure, encodeApplicationFailureCategory, FAILURE_SOURCE, type ProtoFailure } from '../failure';
import { msOptionalToTs } from '../time';
import { isRecord, SymbolBasedInstanceOfError } from '../type-helpers';

const PAYLOAD_VALIDATION_ERROR_TYPE = 'PayloadValidationError';

/** @internal */
export function findPayloadValidationError(error: unknown): ApplicationFailure | undefined {
  return error instanceof ApplicationFailure &&
    error.type === PAYLOAD_VALIDATION_ERROR_TYPE &&
    error.nonRetryable === true
    ? error
    : undefined;
}

/** @internal */
export function clonePayloadValidationErrorAsRetryable(error: ApplicationFailure): ApplicationFailure {
  const clone = ApplicationFailure.create({
    message: error.message,
    type: error.type ?? undefined,
    nonRetryable: false,
    details: error.details ?? undefined,
    cause: error.cause,
    nextRetryDelay: error.nextRetryDelay ?? undefined,
    category: error.category ?? undefined,
  });
  clone.stack = error.stack;
  return clone;
}

/**
 * Build a failure without payloads for the case where the converter reporting the validation
 * error cannot serialize that error's details.
 *
 * @internal
 */
export function payloadFreePayloadValidationFailure(
  error: ApplicationFailure,
  nonRetryable = error.nonRetryable === true
): ProtoFailure {
  return {
    message: error.message,
    stackTrace: error.stack,
    source: FAILURE_SOURCE,
    cause: payloadFreeCause(error.cause, new Set([error])),
    applicationFailureInfo: {
      type: error.type ?? PAYLOAD_VALIDATION_ERROR_TYPE,
      nonRetryable,
      nextRetryDelay: msOptionalToTs(error.nextRetryDelay),
      category: encodeApplicationFailureCategory(error.category),
    },
  };
}

function payloadFreeCause(error: unknown, seen: Set<unknown>): ProtoFailure | undefined {
  if (!isRecord(error) || seen.has(error)) return undefined;
  seen.add(error);

  if (error instanceof ApplicationFailure) {
    return {
      message: error.message,
      stackTrace: error.stack,
      source: FAILURE_SOURCE,
      cause: payloadFreeCause(error.cause, seen),
      applicationFailureInfo: {
        type: error.type ?? 'Error',
        nonRetryable: error.nonRetryable ?? false,
        nextRetryDelay: msOptionalToTs(error.nextRetryDelay),
        category: encodeApplicationFailureCategory(error.category),
      },
    };
  }

  return {
    message: typeof error.message === 'string' ? error.message : String(error.message ?? error),
    stackTrace: typeof error.stack === 'string' ? error.stack : undefined,
    source: FAILURE_SOURCE,
    cause: payloadFreeCause(error.cause, seen),
  };
}

/** @internal */
const workflowTaskPayloadConversionMarker = '__temporal_workflow_task_payload_conversion_error';

/** @internal */
@SymbolBasedInstanceOfError('WorkflowTaskPayloadConversionError')
export class WorkflowTaskPayloadConversionError extends Error {
  constructor(public readonly cause: ApplicationFailure) {
    super(cause.message);
    this.stack = cause.stack;
    Object.defineProperty(this, workflowTaskPayloadConversionMarker, { value: true });
  }
}

/** @internal */
export function isWorkflowTaskPayloadConversionError(error: unknown): error is WorkflowTaskPayloadConversionError {
  if (error instanceof WorkflowTaskPayloadConversionError) return true;
  if (!isRecord(error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, workflowTaskPayloadConversionMarker);
  return (
    descriptor?.value === true && descriptor.enumerable === false && findPayloadValidationError(error.cause) != null
  );
}

/** @internal */
export function findWorkflowTaskPayloadConversionError(error: unknown): WorkflowTaskPayloadConversionError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current)) {
    if (isWorkflowTaskPayloadConversionError(current)) return current;
    seen.add(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return undefined;
}

/** @internal */
export function rethrowPayloadValidationErrorForWorkflowTask(error: unknown): never {
  const payloadValidationError = findPayloadValidationError(error);
  if (payloadValidationError === undefined) throw error;
  throw new WorkflowTaskPayloadConversionError(payloadValidationError);
}

/** @internal */
export function convertPayloadForWorkflowTask<T>(convert: () => T): T {
  try {
    return convert();
  } catch (error) {
    rethrowPayloadValidationErrorForWorkflowTask(error);
  }
}
