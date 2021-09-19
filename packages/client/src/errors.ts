import { temporal } from '@temporalio/proto';

/**
 * Thrown by client when waiting on Workflow execution result if Workflow is terminated
 */
export class WorkflowExecutionTerminatedError extends Error {
  public readonly name: string = 'WorkflowExecutionTerminatedError';
  public constructor(message: string, public readonly details: any[], public readonly identity?: string) {
    super(message);
  }
}

/**
 * Thrown by client when waiting on Workflow execution result if execution times out
 */
export class WorkflowExecutionTimedOutError extends Error {
  public readonly name: string = 'WorkflowExecutionTimedOutError';
  public constructor(message: string, public readonly retryState: temporal.api.enums.v1.RetryState) {
    super(message);
  }
}

/**
 * Thrown by client when waiting on Workflow execution result if execution fails
 */
export class WorkflowExecutionFailedError extends Error {
  public readonly name: string = 'WorkflowExecutionFailedError';
  public constructor(message: string, public readonly cause: Error | undefined) {
    super(message);
  }
}

/**
 * Thrown by client when waiting on Workflow execution result if Workflow is cancelled
 */
export class WorkflowExecutionCancelledError extends Error {
  public readonly name: string = 'WorkflowExecutionCancelledError';
  public constructor(message: string, public readonly details: any[]) {
    super(message);
  }
}

/**
 * Thrown by client when waiting on Workflow execution result if Workflow continues as new.
 *
 * Only thrown if asked not to follow the chain of execution (see {@link WorkflowOptions.followRuns}).
 */
export class WorkflowExecutionContinuedAsNewError extends Error {
  public readonly name: string = 'WorkflowExecutionContinuedAsNewError';
  public constructor(message: string, public readonly newExecutionRunId: string) {
    super(message);
  }
}
