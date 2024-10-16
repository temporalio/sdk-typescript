import { IllegalStateError } from '@temporalio/common';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import { ShutdownError, TransportError, UnexpectedError } from '@temporalio/core-bridge';

/**
 * Thrown from JS if Worker does not shutdown in configured period
 */
@SymbolBasedInstanceOfError('GracefulShutdownPeriodExpiredError')
export class GracefulShutdownPeriodExpiredError extends Error {}

/**
 * Thrown from the Workflow Worker when a Promise is rejected, but there is no `catch` handler
 * for that Promise. This error wraps the original error that was thrown from the Promise.
 *
 * Occurrence of this error generally indicate a missing `await` statement on a call that return
 * a Promise. To silent rejections on a specific Promise, use `promise.catch(funcThatCantThrow)`
 * (e.g. `promise.catch(() => void 0)` or `promise.catch((e) => logger.error(e))`).
 */
// FIXME: At this time, this wrapper is only used for errors that could not be associated with a
//        specific workflow run; it should also be used for unhandled rejections in workflow code,
//        but this is not possible at the moment as we intentionally "unhandle" non-TemporalFailure
//        errors happening in workflow code (i.e. ALL non-TemporalFailure errors thrown from
//        workflow code becomes Unhandled Rejection at some point in our own logic)
@SymbolBasedInstanceOfError('UnhandledRejectionError')
export class UnhandledRejectionError extends Error {
  constructor(
    message: string,
    public cause: unknown
  ) {
    super(message);
  }
}

/**
 * Combined error information for {@link Worker.runUntil}
 */
export interface CombinedWorkerRunErrorCause {
  /**
   * Error thrown by a Worker
   */
  workerError: unknown;
  /**
   * Error thrown by the wrapped promise or function
   */
  innerError: unknown;
}

/**
 * Error thrown by {@link Worker.runUntil} and {@link Worker.runReplayHistories}
 */
@SymbolBasedInstanceOfError('CombinedWorkerRunError')
export class CombinedWorkerRunError extends Error {
  public readonly cause: CombinedWorkerRunErrorCause;

  constructor(message: string, { cause }: { cause: CombinedWorkerRunErrorCause }) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Error thrown by {@link Worker.runUntil} if the provided Promise does not resolve within the specified
 * {@link RunUntilOptions.promiseCompletionTimeout|timeout period} after the Worker has stopped.
 */
@SymbolBasedInstanceOfError('PromiseCompletionTimeoutError')
export class PromiseCompletionTimeoutError extends Error {}

/**
 * @deprecated Import error classes directly
 */
export const errors = {
  IllegalStateError,
  ShutdownError,
  TransportError,
  UnexpectedError,
  GracefulShutdownPeriodExpiredError,
};
