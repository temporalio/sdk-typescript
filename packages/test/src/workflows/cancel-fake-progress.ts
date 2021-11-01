import {
  ActivityCancellationType,
  proxyActivities,
  CancellationScope,
  isCancellation,
  setListener,
  condition,
} from '@temporalio/workflow';
import { activityStartedSignal } from './definitions';
import type * as activities from '../activities';

const { fakeProgress } = proxyActivities<typeof activities>({
  startToCloseTimeout: '200s',
  heartbeatTimeout: '3s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function cancelFakeProgress(): Promise<void> {
  let activityStarted = false;
  setListener(activityStartedSignal, () => void (activityStarted = true));
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
