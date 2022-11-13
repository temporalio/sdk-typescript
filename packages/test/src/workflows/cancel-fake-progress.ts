import {
  ActivityCancellationType,
  proxyActivities,
  CancellationScope,
  isCancellation,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { activityStartedSignal } from './definitions';

const { fakeProgress } = proxyActivities<typeof activities>({
  startToCloseTimeout: '200s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function cancelFakeProgress(): Promise<void> {
  let activityStarted = false;
  setHandler(activityStartedSignal, () => void (activityStarted = true));
  try {
    await CancellationScope.cancellable(async () => {
      const promise = fakeProgress();
      await condition(() => activityStarted);
      CancellationScope.current().cancel();
      await promise;
    });
    throw new Error('Activity completed instead of being cancelled');
  } catch (err) {
    if (!isCancellation(err)) {
      throw err;
    }
  }
}
