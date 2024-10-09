import { IllegalStateError } from '@temporalio/common';
import { isError, SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';

/**
 * The worker has been shut down
 */
@SymbolBasedInstanceOfError('ShutdownError')
export class ShutdownError extends Error {}

/**
 * Thrown after shutdown was requested as a response to a poll function, JS should stop polling
 * once this error is encountered
 */
@SymbolBasedInstanceOfError('TransportError')
export class TransportError extends Error {}

/**
 * Something unexpected happened, considered fatal
 */
@SymbolBasedInstanceOfError('UnexpectedError')
export class UnexpectedError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
  }
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
        newerr = new UnexpectedError(e.message, e);
        newerr.stack = keepStackTrace ? e.stack : undefined;
        return newerr;
    }
  }
  return e;
}
