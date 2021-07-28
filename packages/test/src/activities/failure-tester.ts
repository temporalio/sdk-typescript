import { ApplicationFailure } from '@temporalio/common';

class NonRetryableError extends Error {
  public readonly name = 'NonRetryableError';
}

class RetryableError extends Error {
  public readonly name = 'RetryableError';
}

type ErrorType =
  | 'NonRetryableError'
  | 'RetryableError'
  | 'NonRetryableApplicationFailureWithNonRetryableFlag'
  | 'NonRetryableApplicationFailureWithRetryableFlag'
  | 'RetryableApplicationFailureWithRetryableFlag'
  | 'RetryableApplicationFailureWithNonRetryableFlag'
  | 'RetryableApplicationFailureWithDetails';

export async function throwSpecificError(type: ErrorType, message: string): Promise<void> {
  switch (type) {
    case 'NonRetryableError':
      throw new NonRetryableError(message);
    case 'RetryableError':
      throw new RetryableError(message);
    case 'NonRetryableApplicationFailureWithRetryableFlag':
      throw ApplicationFailure.retryable(message, 'NonRetryableError');
    case 'NonRetryableApplicationFailureWithNonRetryableFlag':
      throw ApplicationFailure.nonRetryable(message, 'NonRetryableError');
    case 'RetryableApplicationFailureWithRetryableFlag':
      throw ApplicationFailure.retryable(message, 'RetryableError');
    case 'RetryableApplicationFailureWithNonRetryableFlag':
      throw ApplicationFailure.nonRetryable(message, 'RetryableError');
    case 'RetryableApplicationFailureWithDetails':
      throw ApplicationFailure.retryable(message, 'RetryableError', 'detail1', 'detail2');
  }
}
