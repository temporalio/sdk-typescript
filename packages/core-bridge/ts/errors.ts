import * as grpc from '@grpc/grpc-js';
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

export interface NativeServiceError {
  name: 'ServiceError';
  message: string;
  code: number;
  details: string;
  metadata: Record<string, Buffer | string>;
  stack?: string;
}

/**
 * A gRPC call failed. The error carries the gRPC status code, message, and other details.
 */
@SymbolBasedInstanceOfError('ServiceError')
export class ServiceError extends Error implements grpc.ServiceError {
  constructor(
    message: string,
    public readonly code: grpc.StatusObject['code'],
    public readonly details: string,
    public readonly metadata: grpc.Metadata
  ) {
    super(message);
  }

  static fromNative(err: NativeServiceError): ServiceError {
    const metadata = new grpc.Metadata();
    for (const [k, v] of Object.entries(err.metadata ?? {})) {
      metadata.set(k, v);
    }
    return new ServiceError(err.message, err.code ?? 0, err.details ?? '', metadata);
  }
}

/**
 * Something unexpected happened, considered fatal
 */
@SymbolBasedInstanceOfError('NativePromiseDroppedError')
export class NativePromiseDroppedError extends UnexpectedError {
  constructor(message: string) {
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

      case 'ServiceError':
        newerr = ServiceError.fromNative(e as NativeServiceError);
        newerr.stack = keepStackTrace ? e.stack : undefined;
        return newerr;
    }

    // Neon ensures that dropping an unsettled Promise results in a rejection, which is
    // much better than just hanging the JS process. Sad though that it does so with an
    // error message that would mean nothing to a user.
    if (e.message === '`neon::types::Deferred` was dropped without being settled') {
      newerr = new NativePromiseDroppedError('Native Promise was dropped without being settled');
      newerr.stack = keepStackTrace ? e.stack : undefined;
      return newerr;
    }
  }
  return e;
}
