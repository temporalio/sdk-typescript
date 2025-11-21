import { continueAsNew, ApplicationFailure } from '@temporalio/workflow';

/**
 * Verifies that Workflow does not generate any more commands after it is considered complete
 */
export async function tryToContinueAfterCompletion(): Promise<void> {
  await Promise.race([
    // Note that continueAsNew only throws after microtasks and as a result, loses the race
    Promise.resolve().then(() => continueAsNew<typeof tryToContinueAfterCompletion>()),
    Promise.reject(ApplicationFailure.nonRetryable('fail before continue')),
  ]);
}
