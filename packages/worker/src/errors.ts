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
 * Occurence of this error generally indicate a missing `await` statement on a call that return
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
 * @deprecated Import error classes directly
 */
export const errors = {
  IllegalStateError,
  ShutdownError,
  TransportError,
  UnexpectedError,
  GracefulShutdownPeriodExpiredError,
};
