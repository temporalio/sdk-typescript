/**
 * This workflow does a little bit of everything
 */
import {
  sleep,
  startChild,
  proxyActivities,
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  proxyLocalActivities,
} from '@temporalio/workflow';
import * as activities from '../activities';
import { signalTarget } from './signal-target';
import { activityStartedSignal, unblockSignal } from './definitions';

const { fakeProgress, queryOwnWf } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1m',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

const { echo } = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '1m',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export const stepQuery = defineQuery<number>('step');

export async function smorgasbord(iteration = 0): Promise<void> {
  let unblocked = false;

  setHandler(stepQuery, () => iteration);
  setHandler(activityStartedSignal, () => void (unblocked = true));

  try {
    await CancellationScope.cancellable(async () => {
      const activityPromise = fakeProgress(100, 10);
      const queryActPromise = queryOwnWf(stepQuery);
      const timerPromise = sleep(1000);

      const childWfPromise = (async () => {
        const childWf = await startChild(signalTarget, {});
        await childWf.signal(unblockSignal);
        await childWf.result();
      })();

      const localActivityPromise = echo('local-activity');

      if (iteration === 0) {
        CancellationScope.current().cancel();
      }

      await Promise.all([
        activityPromise,
        queryActPromise,
        timerPromise,
        childWfPromise,
        localActivityPromise,
        condition(() => unblocked),
      ]);
    });
  } catch (e) {
    if (iteration !== 0 || !isCancellation(e)) {
      throw e;
    }
  }
  if (iteration < 2) {
    await continueAsNew<typeof smorgasbord>(iteration + 1);
  }
}
