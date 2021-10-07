// @@@SNIPSTART nodejs-activity-fake-progress
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';

export async function fakeProgress(sleepIntervalMs = 1000, numIters = 100): Promise<void> {
  try {
    for (let progress = 1; progress <= numIters; ++progress) {
      // sleep for given interval or throw if Activity is cancelled
      await Context.current().sleep(sleepIntervalMs);
      Context.current().heartbeat(progress);
    }
  } catch (err) {
    if (err instanceof CancelledFailure) {
      // Cleanup
    }
    throw err;
  }
}
// @@@SNIPEND
