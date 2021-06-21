import { Context, CancellationScope, CancelledError, sleep, Trigger } from '@temporalio/workflow';
import { CancellableHTTPRequest } from '../interfaces';
import { cancellableFetch } from '@activities';

const fetch = Context.configure(cancellableFetch, {
  type: 'remote',
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
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

async function main(url: string, waitForActivityCancelled: boolean): Promise<void> {
  try {
    await CancellationScope.cancellable(async () => {
      const promise = fetch(url, true);
      await activityStarted;
      CancellationScope.current().cancel();
      await promise;
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      if (waitForActivityCancelled) {
        await Promise.race([
          activityCancelled,
          CancellationScope.nonCancellable(async () => {
            await sleep(10000);
            throw new Error('Confirmation of activity cancellation never arrived');
          }),
        ]);
      }
    }
    throw err;
  }
}

export const workflow: CancellableHTTPRequest = { main, signals };
