/**
 * Thrown from JS if Worker does not shutdown in configured period
 */
export class GracefulShutdownPeriodExpiredError extends Error {
  public readonly name = 'GracefulShutdownPeriodExpiredError';
}

/**
 * These are rexported here only to maintain
 */
export { IllegalStateError } from '@temporalio/common';
export { ShutdownError, TransportError, UnexpectedError } from '@temporalio/core-bridge';
