// @@@SNIPSTART nodejs-multiple-activities-single-timeout-workflow-alternative-impl
import { CancelledError, CancellationScope, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  try {
    const scope = new CancellationScope();
    const promise = scope.run(() => sleep(1));
    scope.cancel(); // <-- Cancel the timer created in scope
    await promise; // <-- Throws CancelledError
  } catch (e) {
    if (e instanceof CancelledError) {
      console.log('Timer cancelled 👍');
    } else {
      throw e; // <-- Fail the workflow
    }
  }
}
// @@@SNIPEND
