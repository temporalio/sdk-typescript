/**
 * Demonstrates the basics of cancellation scopes.
 * Used in the documentation site.
 */
// @@@SNIPSTART nodejs-cancel-a-timer-from-workflow
import { CancelledFailure, CancellationScope, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function main(): Promise<void> {
  // Timers and Activities are automatically cancelled when their containing scope is cancelled.
  try {
    await CancellationScope.cancellable(async () => {
      const promise = sleep(1); // <-- Will be cancelled because it is attached to this closure's scope
      CancellationScope.current().cancel();
      await promise; // <-- Promise must be awaited in order for `cancellable` to throw
    });
  } catch (e) {
    if (e instanceof CancelledFailure) {
      console.log('Timer cancelled 👍');
    } else {
      throw e; // <-- Fail the workflow
    }
  }
}

export const workflow: Empty = { main };
// @@@SNIPEND
