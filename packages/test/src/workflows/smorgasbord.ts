/**
 * This workflow does a little bit of everything
 */
import {
  sleep,
  startChild,
  createActivityHandle,
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  defineQuery,
  setListener,
  condition,
  continueAsNew,
} from '@temporalio/workflow';
import * as activities from '../activities/';
import { signalTarget } from './signal-target';
import { activityStartedSignal, unblockSignal } from './definitions';

const { fakeProgress } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '5s',
  scheduleToCloseTimeout: '10s',
  heartbeatTimeout: '3s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const { queryOwnWf } = createActivityHandle<typeof activities>({
  // This one needs a long timeout because of the queries getting dropped bug
  startToCloseTimeout: '35s',
  scheduleToCloseTimeout: '40s',
});

export const stepQuery = defineQuery<number>('step');

export async function smorgasbord(iteration = 0): Promise<void> {
  let unblocked = false;

  setListener(stepQuery, () => iteration);
  setListener(activityStartedSignal, () => void (unblocked = true));

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

      if (iteration === 0) {
        CancellationScope.current().cancel();
      }

      await Promise.all([activityPromise, queryActPromise, timerPromise, childWfPromise, condition(() => unblocked)]);
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
