import { IllegalStateError } from '@temporalio/common';
import { isError, symbolBasedInstanceOf } from '@temporalio/common/lib/type-helpers';

/**
 * The worker has been shut down
 */
@symbolBasedInstanceOf('ShutdownError')
export class ShutdownError extends Error {
  public readonly name = 'ShutdownError';
}

/**
 * Thrown after shutdown was requested as a response to a poll function, JS should stop polling
 * once this error is encountered
 */
@symbolBasedInstanceOf('TransportError')
export class TransportError extends Error {
  public readonly name = 'TransportError';
}

/**
 * Something unexpected happened, considered fatal
 */
@symbolBasedInstanceOf('UnexpectedError')
export class UnexpectedError extends Error {
  public readonly name = 'UnexpectedError';
}

export { IllegalStateError };

// Check if the error's class is exactly Error (not a descendant of it), in a realm-safe way
function isBareError(e: unknown): e is Error {
  return isError(e) && Object.getPrototypeOf(e)?.name === 'Error';
}

export function convertFromNamedError(e: unknown, keepStackTrace: boolean): unknown {
  if (isBareError(e)) {
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
