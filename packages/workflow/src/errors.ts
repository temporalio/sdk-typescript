import { ActivityFailure, CancelledFailure, ChildWorkflowFailure } from '@temporalio/common';
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

/**
 * Returns whether provided `err` is caused by cancellation
 */
export function isCancellation(err: unknown): boolean {
  return (
    CancelledFailure.is(err) ||
    ((ActivityFailure.is(err) || ChildWorkflowFailure.is(err)) && CancelledFailure.is(err.cause))
  );
}
