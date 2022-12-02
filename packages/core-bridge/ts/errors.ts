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

export function convertFromNamedError(e: unknown, keepStackTrace: boolean): unknown {
  // Check if the error's class is exactly Error (not a descendant of it).
  // The instanceof check both ensure that e is indeed an object AND avoid
  // TypeScript from complaining on accessing Error properties.
  if (e instanceof Error && Object.getPrototypeOf(e).name === 'Error') {
    let newerr: Error;
    switch (e.name) {
      case 'TransportError':
        newerr = new TransportError(e.message);
        newerr.stack = keepStackTrace ? e.stack : undefined;
        return newerr;

      case 'IllegalStateError':
        newerr = new IllegalStateError(e.message);
        newerr.stack = keepStackTrace ? e.stack : undefined;
        return newerr;

      case 'ShutdownError':
        newerr = new ShutdownError(e.message);
        newerr.stack = keepStackTrace ? e.stack : undefined;
        return newerr;

      case 'UnexpectedError':
        newerr = new UnexpectedError(e.message);
        newerr.stack = keepStackTrace ? e.stack : undefined;
        return newerr;
    }
  }
  return e;
}
