import { ActivityCancellationType, Context, CancellationScope, isCancellation, Trigger } from '@temporalio/workflow';
import { CancellableHTTPRequest } from '../interfaces';
import * as activities from '../activities';

const { cancellableFetch } = Context.configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

const activityStarted = new Trigger<void>();

const signals = {
  activityStarted(): void {
    activityStarted.resolve();
  },
};

async function execute(url: string): Promise<void> {
  try {
    await CancellationScope.cancellable(async () => {
      const promise = cancellableFetch(url, true);
      await activityStarted;
      CancellationScope.current().cancel();
      await promise;
    });
  } catch (err) {
    if (!isCancellation(err)) {
      throw err;
    }
  }
}

export const workflow: CancellableHTTPRequest = { execute, signals };
