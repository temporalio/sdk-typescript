import { coresdk } from '@temporalio/proto/lib/coresdk';

export class ValueError extends Error {
  public readonly name: string = 'ValueError';
}

export class DataConverterError extends Error {
  public readonly name: string = 'DataConverterError';
}

/**
 * Used in different parts of the project to signal that something unexpected has happened
 */
export class IllegalStateError extends Error {
  public readonly name: string = 'IllegalStateError';
}

export function errorToUserCodeFailure(err: unknown, nonRetryable?: boolean): coresdk.common.IUserCodeFailure {
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err instanceof Error) {
    return { message: err.message, type: err.name, stackTrace: err.stack, nonRetryable };
  }

  // Default value
  return { message: 'Unknown error' };
}
