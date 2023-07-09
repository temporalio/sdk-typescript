import { ActivityFailure, CancelledFailure, ChildWorkflowFailure } from '@temporalio/common';
import { symbolBasedInstanceOf } from '@temporalio/common/lib/type-helpers';

/**
 * Base class for all workflow errors
 */
@symbolBasedInstanceOf('WorkflowError')
export class WorkflowError extends Error {
  public readonly name: string = 'WorkflowError';
}

/**
 * Thrown in workflow when it tries to do something that non-deterministic such as construct a WeakRef()
 */
@symbolBasedInstanceOf('DeterminismViolationError')
export class DeterminismViolationError extends WorkflowError {
  public readonly name: string = 'DeterminismViolationError';
}

/**
 * Returns whether provided `err` is caused by cancellation
 */
export function isCancellation(err: unknown): boolean {
  return (
    err instanceof CancelledFailure ||
    ((err instanceof ActivityFailure || err instanceof ChildWorkflowFailure) && err.cause instanceof CancelledFailure)
  );
}
