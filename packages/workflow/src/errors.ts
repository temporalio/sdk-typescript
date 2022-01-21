import { CancelledFailure, ActivityFailure, ChildWorkflowFailure } from '@temporalio/common';

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
 * This exception is thrown in the following cases:
 *  - Workflow with the same WorkflowId is currently running
 *  - There is a closed workflow with the same ID and the {@link WorkflowOptions.workflowIdReusePolicy}
 *    is `WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE`
 *  - There is successfully closed workflow with the same ID and the {@link WorkflowOptions.workflowIdReusePolicy}
 *    is `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY`
 *  - {@link Workflow.execute} is called *more than once* on a handle created through {@link createChildWorkflowHandle} and the
 *    {@link WorkflowOptions.workflowIdReusePolicy} is `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE`
 */
export class WorkflowExecutionAlreadyStartedError extends WorkflowError {
  public readonly name: string = 'ChildWorkflowExecutionAlreadyStartedError';

  constructor(message: string, public readonly workflowId: string, public readonly workflowType: string) {
    super(message);
  }
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
