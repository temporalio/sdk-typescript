import { ActivityCancellationType, Context, CancellationScope, isCancellation, Trigger } from '@temporalio/workflow';
import { ActivitySignalHandler } from '../interfaces';
import * as activities from '@activities';

const fakeProgress = Context.configure(activities.fakeProgress, {
  type: 'remote',
  startToCloseTimeout: '200s',
  heartbeatTimeout: '2s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

const activityStarted = new Trigger<void>();

const signals = {
  activityStarted(): void {
    activityStarted.resolve();
  },
};

async function main(): Promise<void> {
  try {
    await CancellationScope.cancellable(async () => {
      const promise = fakeProgress();
      await activityStarted;
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

export const workflow: ActivitySignalHandler = { main, signals };
