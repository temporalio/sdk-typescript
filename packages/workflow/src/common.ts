import { coresdk } from '@temporalio/proto';

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
