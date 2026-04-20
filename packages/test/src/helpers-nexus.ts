import * as nexus from 'nexus-rpc';

/**
 * Older servers wrap handler errors in an extra HandlerError; newer servers do not.
 * Given a HandlerError, skip past one optional HandlerError wrapper and return the
 * inner cause (e.g. ApplicationFailure, CancelledFailure, or other Error).
 */
export function unwrapHandlerErrorCause(handler: nexus.HandlerError): unknown {
  return handler.cause instanceof nexus.HandlerError
    ? handler.cause.cause // old server: skip extra wrapper
    : handler.cause; // new server: cause is direct
}

/**
 * Given a HandlerError, return the innermost HandlerError in the chain
 * (skipping one optional server-added wrapper).
 */
export function innermostHandlerError(handler: nexus.HandlerError): nexus.HandlerError {
  return handler.cause instanceof nexus.HandlerError ? handler.cause : handler;
}
