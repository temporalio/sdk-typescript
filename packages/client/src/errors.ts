import { ServiceError as GrpcServiceError, status } from '@grpc/grpc-js';
import { RetryState } from '@temporalio/common';
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
    public readonly cause: Error | undefined,
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
  public constructor(
    message: string,
    public readonly cause: Error | undefined
  ) {
    super(message);
  }
}

/**
 * Thrown by the client if the Update call timed out or was cancelled.
 * This doesn't mean the update itself was timed out or cancelled.
 */
@SymbolBasedInstanceOfError('WorkflowUpdateRPCTimeoutOrCancelledError')
export class WorkflowUpdateRPCTimeoutOrCancelledError extends Error {
  public readonly cause?: Error;

  public constructor(message: string, opts?: { cause: Error }) {
    super(message);
    this.cause = opts?.cause;
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
  public constructor(
    message: string,
    public readonly newExecutionRunId: string
  ) {
    super(message);
  }
}

/**
 * Returns true if the provided error is a {@link GrpcServiceError}.
 */
export function isGrpcServiceError(err: unknown): err is GrpcServiceError {
  return (
    isError(err) &&
    typeof (err as GrpcServiceError)?.details === 'string' &&
    isRecord((err as GrpcServiceError).metadata)
  );
}

/**
 * Returns true if the provided error or its cause is a {@link GrpcServiceError} with code DEADLINE_EXCEEDED.
 *
 * @see {@link Connection.withDeadline}
 */
export function isGrpcDeadlineError(err: unknown): err is Error {
  while (isError(err)) {
    if (isGrpcServiceError(err) && (err as GrpcServiceError).code === status.DEADLINE_EXCEEDED) {
      return true;
    }
    err = (err as any).cause;
  }
  return false;
}

/**
 * Returns true if the provided error or its cause is a {@link GrpcServiceError} with code CANCELLED.
 *
 * @see {@link Connection.withAbortSignal}
 */
export function isGrpcCancelledError(err: unknown): err is Error {
  while (isError(err)) {
    if (isGrpcServiceError(err) && (err as GrpcServiceError).code === status.CANCELLED) {
      return true;
    }
    err = (err as any).cause;
  }
  return false;
}

/**
 * @deprecated Use `isGrpcServiceError` instead
 */
export const isServerErrorResponse = isGrpcServiceError;
