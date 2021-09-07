import {
  ActivityCancellationType,
  configureActivities,
  CancellationScope,
  isCancellation,
  Trigger,
} from '@temporalio/workflow';
import { ActivitySignalHandler } from '../interfaces';
import type * as activities from '../activities';

const { fakeProgress } = configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '200s',
  heartbeatTimeout: '2s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export const cancelFakeProgress: ActivitySignalHandler = () => {
  const activityStarted = new Trigger<void>();

  return {
    signals: {
      activityStarted(): void {
        activityStarted.resolve();
      },
    },
    async execute(): Promise<void> {
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
    },
  };
};
