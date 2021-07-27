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
 * Thrown in workflow when it trys to do something that non-deterministic such as construct a WeakMap()
 */
export class DeterminismViolationError extends Error {
  public readonly name: string = 'DeterminismViolationError';
}
