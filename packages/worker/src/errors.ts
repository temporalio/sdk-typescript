/**
 * Thrown from JS if Worker does not shutdown in configured period
 */
export class GracefulShutdownPeriodExpiredError extends Error {
  public readonly name = 'GracefulShutdownPeriodExpiredError';
}
