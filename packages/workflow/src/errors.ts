/**
 * Base class for all workflow errors
 */
export class WorkflowError extends Error {
  public readonly name: string = 'WorkflowError';
}

/**
 * Thrown in workflow when it tries to do something that non-deterministic such as construct a WeakRef()
 */
export class DeterminismViolationError extends WorkflowError {
  public readonly name: string = 'DeterminismViolationError';
}

function looksLikeError(err: unknown): err is { name: string; cause?: unknown } {
  return typeof err === 'object' && err != null && Object.prototype.hasOwnProperty.call(err, 'name');
}

/**
 * Returns whether provided `err` is caused by cancellation
 */
export function isCancellation(err: unknown): boolean {
  if (!looksLikeError(err)) return false;
  return (
    err.name === 'CancelledFailure' ||
    ((err.name === 'ActivityFailure' || err.name === 'ChildWorkflowFailure') &&
      looksLikeError(err.cause) &&
      err.cause.name === 'CancelledFailure')
  );
}
