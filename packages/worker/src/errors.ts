/**
 * An unhandled error while communicating with the server, considered fatal
 */
export class ShutdownError extends Error {
  public readonly name = 'ShutdownError';
}

/**
 * Thrown after shutdown was requested as a response to a poll function, JS should stop polling
 * once this error is encountered
 */
export class TransportError extends Error {
  public readonly name = 'TransportError';
}

/**
 * Workflow did something Core did not expect, it should be immediately deleted from the cache
 */
export class WorkflowError extends Error {
  public readonly name = 'WorkflowError';

  public constructor(message: string, public readonly runId: string, public readonly source: string) {
    super(message);
  }
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
