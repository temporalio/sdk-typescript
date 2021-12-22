/**
 * Used in test-async-completion to schedule an activity
 * @module
 */

import { CancellationScope, ActivityCancellationType, proxyActivities, sleep } from '@temporalio/workflow';
import type { Activities } from '../activities/async-completer';

export async function runAnAsyncActivity(cancel?: boolean): Promise<string> {
  const { completeAsync } = proxyActivities<Activities>({
    scheduleToCloseTimeout: '30 minutes',
    retry: {
      maximumAttempts: 1,
    },
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  });

  return await CancellationScope.cancellable(async () => {
    const promise = completeAsync();
    if (cancel) {
      // So the activity can be scheduled
      await sleep(100);
      CancellationScope.current().cancel();
    }
    return await promise;
  });
}
