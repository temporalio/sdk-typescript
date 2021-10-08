import {
  ActivityCancellationType,
  createActivityHandle,
  CancellationScope,
  isCancellation,
  setListener,
  condition,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { activityStartedSignal } from './definitions';

const { cancellableFetch } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '20s',
  heartbeatTimeout: '3s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function cancellableHTTPRequest(url: string): Promise<void> {
  let activityStarted = false;
  setListener(activityStartedSignal, () => void (activityStarted = true));
  try {
    await CancellationScope.cancellable(async () => {
      const promise = cancellableFetch(url, true);
      await condition(() => activityStarted);
      CancellationScope.current().cancel();
      await promise;
    });
  } catch (err) {
    if (!isCancellation(err)) {
      throw err;
    }
  }
}
