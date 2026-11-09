import { ApplicationFailure, sleep } from '@temporalio/workflow';

// The filename tests that stack trace paths preserve spaces, Unicode, and literal percent escapes.
export async function throwWithSpecialCharacters(): Promise<void> {
  throw ApplicationFailure.nonRetryable('failure');
}

export async function sleepWithSpecialCharacters(): Promise<void> {
  await sleep('1 hour');
}
