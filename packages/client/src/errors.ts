import { ServiceError as GrpcServiceError } from '@grpc/grpc-js';
import { RetryState, TemporalFailure } from '@temporalio/common';
import { isError, isRecord, SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';

/**
 * Generic Error class for errors coming from the service
 */
@SymbolBasedInstanceOfError('ServiceError')
export class ServiceError extends Error {
  public readonly cause?: Error;

  constructor(message: string, opts?: { cause: Error }) {
    super(message);
    this.cause = opts?.cause;
  }
}

/**
 * Thrown by the client while waiting on Workflow execution result if execution
 * completes with failure.
 *
 * The failure type will be set in the `cause` attribute.
 *
 * For example if the workflow is cancelled, `cause` will be set to
 * {@link CancelledFailure}.
 */
@SymbolBasedInstanceOfError('WorkflowFailedError')
export class WorkflowFailedError extends Error {
  public constructor(
    message: string,
    public readonly cause: TemporalFailure | undefined,
    public readonly retryState: RetryState
  ) {
    super(message);
  }
}

/**
 * Thrown by the client while waiting on Workflow Update result if Update
 * completes with failure.
 */
@SymbolBasedInstanceOfError('WorkflowUpdateFailedError')
export class WorkflowUpdateFailedError extends Error {
  public constructor(message: string, public readonly cause: TemporalFailure | undefined) {
    super(message);
  }
}

/**
 * Thrown the by client while waiting on Workflow execution result if Workflow
 * continues as new.
 *
 * Only thrown if asked not to follow the chain of execution (see {@link WorkflowOptions.followRuns}).
 */
@SymbolBasedInstanceOfError('WorkflowExecutionContinuedAsNewError')
export class WorkflowContinuedAsNewError extends Error {
  public constructor(message: string, public readonly newExecutionRunId: string) {
    super(message);
  }
}

export function isGrpcServiceError(err: unknown): err is GrpcServiceError {
  return (
    isError(err) &&
    typeof (err as GrpcServiceError)?.details === 'string' &&
    isRecord((err as GrpcServiceError).metadata)
  );
}

/**
 * @deprecated Use `isGrpcServiceError` instead
 */
export const isServerErrorResponse = isGrpcServiceError;
