import { ActivityFailure, CancelledFailure, ChildWorkflowFailure } from '@temporalio/common';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';

/**
 * Base class for all workflow errors
 */
@SymbolBasedInstanceOfError('WorkflowError')
export class WorkflowError extends Error {}

/**
 * Thrown in workflow when it tries to do something that non-deterministic such as construct a WeakRef()
 */
@SymbolBasedInstanceOfError('DeterminismViolationError')
export class DeterminismViolationError extends WorkflowError {}

/**
 * Returns whether provided `err` is caused by cancellation
 */
export function isCancellation(err: unknown): boolean {
  return (
    err instanceof CancelledFailure ||
    ((err instanceof ActivityFailure || err instanceof ChildWorkflowFailure) && err.cause instanceof CancelledFailure)
  );
}
