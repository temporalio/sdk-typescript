import { IllegalStateError } from '@temporalio/common';
import { symbolBasedInstanceOf } from '@temporalio/common/lib/type-helpers';
import { ShutdownError, TransportError, UnexpectedError } from '@temporalio/core-bridge';

/**
 * Thrown from JS if Worker does not shutdown in configured period
 */
@symbolBasedInstanceOf('GracefulShutdownPeriodExpiredError')
export class GracefulShutdownPeriodExpiredError extends Error {
  public readonly name = 'GracefulShutdownPeriodExpiredError';
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
