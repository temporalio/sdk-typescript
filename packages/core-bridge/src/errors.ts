/**
 * The worker has been shut down
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
 * Something unexpected happened, considered fatal
 */
export class UnexpectedError extends Error {
  public readonly name = 'UnexpectedError';
}
