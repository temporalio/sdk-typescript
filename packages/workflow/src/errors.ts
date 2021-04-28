import * as iface from '@temporalio/proto';

export class WorkflowExecutionTerminatedError extends Error {
  public readonly name: string = 'WorkflowExecutionTerminatedError';
  public constructor(message: string, public readonly details: any[], public readonly identity?: string) {
    super(message);
  }
}

export class WorkflowExecutionTimedOutError extends Error {
  public readonly name: string = 'WorkflowExecutionTimedOutError';
  public constructor(message: string, public readonly retryState: iface.temporal.api.enums.v1.RetryState) {
    super(message);
  }
}

export class WorkflowExecutionFailedError extends Error {
  public readonly name: string = 'WorkflowExecutionFailedError';
}

export class WorkflowExecutionCancelledError extends Error {
  public readonly name: string = 'WorkflowExecutionCancelledError';
  public constructor(message: string, public readonly details: any[]) {
    super(message);
  }
}

export class WorkflowExecutionContinuedAsNewError extends Error {
  public readonly name: string = 'WorkflowExecutionContinuedAsNewError';
  public constructor(message: string, public readonly newExecutionRunId: string) {
    super(message);
  }
}

/**
 * Used to denote where the cancellation was originated
 *
 * - external - The workflow was cancelled by an external API call
 * - internal - Cancellation was requested by using `cancel` from within a workflow
 */
export type CancellationSource = 'internal' | 'external';

/**
 * Thrown in workflow when it is requested to be cancelled either externally or internally.
 *
 * @see {@link CancellationSource}
 */
export class CancellationError extends Error {
  public readonly name: string = 'CancellationError';
  public constructor(message: string, public readonly source: CancellationSource) {
    super(message);
  }
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
