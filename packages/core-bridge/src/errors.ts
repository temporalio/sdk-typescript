import { IllegalStateError } from '@temporalio/common';

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
export { IllegalStateError };

export function convertFromNamedError(e: unknown): unknown {
  if (e instanceof Error) {
    switch (e.name) {
      case 'TransportError':
        return new TransportError(e.message);
      case 'IllegalStateError':
        return new IllegalStateError(e.message);
      case 'ShutdownError':
        return new ShutdownError(e.message);
      case 'UnexpectedError':
        return new UnexpectedError(e.message);
    }
  }
  return e;
}
