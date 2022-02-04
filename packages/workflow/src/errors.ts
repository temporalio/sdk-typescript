import { CancelledFailure, ActivityFailure, ChildWorkflowFailure } from '@temporalio/common';
export { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';

/**
 * Base class for all workflow errors
 */
export class WorkflowError extends Error {
  public readonly name: string = 'WorkflowError';
}

/**
 * Thrown in workflow when it tries to do something that non-deterministic such as construct a WeakMap()
 */
export class DeterminismViolationError extends WorkflowError {
  public readonly name: string = 'DeterminismViolationError';
}

/**
 * Returns whether provided `err` is caused by cancellation
 */
export function isCancellation(err: unknown): boolean {
  return (
    err instanceof CancelledFailure ||
    ((err instanceof ActivityFailure || err instanceof ChildWorkflowFailure) && isCancellation(err.cause))
  );
}
