import { RetryState, TemporalFailure } from '@temporalio/common';

/**
 * Thrown by the client while waiting on Workflow execution result if execution
 * completes with failure.
 *
 * The failure type will be set in the `cause` attribute.
 *
 * For example if the workflow is cancelled, `cause` will be set to
 * {@link CancelledFailure}.
 */
export class WorkflowFailedError extends Error {
  public readonly name: string = 'WorkflowExecutionFailedError';
  public constructor(
    message: string,
    public readonly cause: TemporalFailure | undefined,
    public readonly retryState: RetryState
  ) {
    super(message);
  }
}

/**
 * Thrown the by client while waiting on Workflow execution result if Workflow
 * continues as new.
 *
 * Only thrown if asked not to follow the chain of execution (see {@link WorkflowOptions.followRuns}).
 */
export class WorkflowContinuedAsNewError extends Error {
  public readonly name: string = 'WorkflowExecutionContinuedAsNewError';
  public constructor(message: string, public readonly newExecutionRunId: string) {
    super(message);
  }
}
