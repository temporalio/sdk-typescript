import {
  ActivityCancellationType,
  createActivityHandle,
  CancellationScope,
  isCancellation,
  Trigger,
} from '@temporalio/workflow';
import { CancellableHTTPRequest } from '../interfaces';
import type * as activities from '../activities';

const { cancellableFetch } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export const cancellableHTTPRequest: CancellableHTTPRequest = (url: string) => {
  const activityStarted = new Trigger<void>();

  return {
    async execute(): Promise<void> {
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
    },
    signals: {
      activityStarted(): void {
        activityStarted.resolve();
      },
    },
  };
};
