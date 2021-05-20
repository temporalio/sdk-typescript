import { Context, CancellationError, cancel, sleep } from '@temporalio/workflow';
import { ActivitySignalHandler } from '../interfaces';
import * as activities from '@activities';
import { ResolvablePromise } from './resolvable-promise';

const fakeProgress = Context.configure(activities.fakeProgress, {
  type: 'remote',
  startToCloseTimeout: '200s',
  heartbeatTimeout: '2s',
});

const activityStarted = new ResolvablePromise<void>();
const activityCancelled = new ResolvablePromise<void>();

const signals = {
  activityStarted(): void {
    activityStarted.resolve(undefined);
  },
  activityCancelled(): void {
    activityCancelled.resolve(undefined);
  },
};

async function main(): Promise<void> {
  const promise = fakeProgress();
  await activityStarted;
  cancel(promise);
  try {
    await promise;
    throw new Error('Activity completed instead of being cancelled');
  } catch (err) {
    if (err instanceof CancellationError) {
      await Promise.race([
        activityCancelled,
        (async () => {
          await sleep(100000);
          throw new Error('Confirmation of activity cancellation never arrived');
        })(),
      ]);
    } else {
      throw err;
    }
  }
}

export const workflow: ActivitySignalHandler = { main, signals };
