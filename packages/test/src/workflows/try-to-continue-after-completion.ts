import { continueAsNew } from '@temporalio/workflow';

/**
 * Verifies that Workflow does not generate any more commands after it is considered complete
 */
export async function tryToContinueAfterCompletion(): Promise<void> {
  await Promise.race([
    // Note that continueAsNew only throws after microtasks and as a result, looses the race
    continueAsNew<typeof tryToContinueAfterCompletion>(),
    Promise.reject(new Error('fail before continue')),
  ]);
}
