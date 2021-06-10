import { Context, CancellationError, CancellationScope, sleep, Trigger } from '@temporalio/workflow';
import { ActivitySignalHandler } from '../interfaces';
import * as activities from '@activities';

const fakeProgress = Context.configure(activities.fakeProgress, {
  type: 'remote',
  startToCloseTimeout: '200s',
  heartbeatTimeout: '2s',
});

const activityStarted = new Trigger<void>();
const activityCancelled = new Trigger<void>();

const signals = {
  activityStarted(): void {
    activityStarted.resolve();
  },
  activityCancelled(): void {
    activityCancelled.resolve();
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
    if (err instanceof CancellationError) {
      await Promise.race([
        activityCancelled,
        CancellationScope.nonCancellable(async () => {
          await sleep(100000);
          throw new Error('Confirmation of activity cancellation never arrived');
        }),
      ]);
    } else {
      throw err;
    }
  }
}

export const workflow: ActivitySignalHandler = { main, signals };
