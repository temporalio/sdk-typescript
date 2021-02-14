import * as iface from '../../proto/core-interface';

export class WorkflowExecutionTerminatedError extends Error {
  public readonly name: string = 'WorkflowExecutionTerminatedError';
  public constructor(message: string, public readonly details: any[], public readonly identity?: string) {
    super(message);
  }
}

export class WorkflowExecutionTimedOutError extends Error {
  public readonly name: string = 'WorkflowExecutionTimedOutError';
  public constructor(
    message: string,
    public readonly retryState: iface.temporal.api.enums.v1.RetryState,
  ) {
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

// Thrown in workflow
export class CancellationError extends Error {
  public readonly name: string = 'CancellationError';
};

