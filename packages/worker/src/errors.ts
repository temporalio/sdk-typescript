export { IllegalStateError } from '@temporalio/common';

/**
 * The worker has been shut down
 */
export class ShutdownError extends Error {
  public readonly name = 'ShutdownError';
}

/**
 * The worker never existed or already completed shutdown
 */
export class NoWorkerRegisteredError extends Error {
  public readonly name = 'NoWorkerRegisteredError';

  public constructor(public readonly queue: string) {
    super(`No worker for queue ${queue}`);
  }
}

/**
 * Thrown after shutdown was requested as a response to a poll function, JS should stop polling
 * once this error is encountered
 */
export class TransportError extends Error {
  public readonly name = 'TransportError';
}

/**
 * Something unexpected happened, considered fatal
 */
export class UnexpectedError extends Error {
  public readonly name = 'UnexpectedError';
}

/**
 * Thrown from JS if Worker does not shutdown in configured period
 */
export class GracefulShutdownPeriodExpiredError extends Error {
  public readonly name = 'GracefulShutdownPeriodExpiredError';
}
