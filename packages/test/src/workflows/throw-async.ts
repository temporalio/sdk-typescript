import { ApplicationFailure } from '@temporalio/workflow';

export async function throwAsync(variant: 'retryable' | 'nonRetryable' = 'nonRetryable'): Promise<void> {
  throw ApplicationFailure[variant]('failure');
}
