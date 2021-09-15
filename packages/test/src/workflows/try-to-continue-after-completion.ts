import { continueAsNew } from '@temporalio/workflow';
import { Returner } from '../interfaces';

/**
 * Verifies that Workflow does not generate any more commands after it is considered complete
 */
export const tryToContinueAfterCompletion: Returner<void> = () => ({
  async execute() {
    await Promise.race([
      // Note that continueAsNew only throws after microtasks and as a result, looses the race
      continueAsNew<typeof tryToContinueAfterCompletion>(),
      Promise.reject(new Error('fail before continue')),
    ]);
  },
});
