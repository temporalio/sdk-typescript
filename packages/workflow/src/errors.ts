/**
 * Thrown in workflow when it is requested to be cancelled either externally or internally
 */
export class CancelledError extends Error {
  public readonly name: string = 'CancelledError';
}

/**
 * Thrown in workflow when it receives a client cancellation request
 */
export class WorkflowCancelledError extends CancelledError {
  public readonly name: string = 'WorkflowCancelledError';
}

/**
 * Used in different parts of the project to signal that something unexpected has happened
 */
export class IllegalStateError extends Error {
  public readonly name: string = 'IllegalStateError';
}

/**
 * Thrown in workflow when it trys to do something that non-deterministic such as construct a WeakMap()
 */
export class DeterminismViolationError extends Error {
  public readonly name: string = 'DeterminismViolationError';
}
