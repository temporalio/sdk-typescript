import { ApplicationFailure } from '@temporalio/workflow';

export async function throwAsync(): Promise<void> {
  throw ApplicationFailure.nonRetryable('failure');
}
