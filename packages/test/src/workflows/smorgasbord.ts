/**
 * This workflow does a little bit of everything
 */
import {
  sleep,
  createChildWorkflowHandle,
  createActivityHandle,
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  defineQuery,
  setListener,
  condition,
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

export async function smorgasbord(): Promise<void> {
  let step = 0;
  let unblocked = false;

  setListener(stepQuery, () => step);
  setListener(activityStartedSignal, () => void (unblocked = true));

  for (; step < 2; ++step) {
    try {
      await CancellationScope.cancellable(async () => {
        const activityPromise = fakeProgress(100, 10);
        const queryActPromise = queryOwnWf(stepQuery);
        const timerPromise = sleep(1000);

        const childWf = createChildWorkflowHandle(signalTarget);
        const childWfPromise = (async () => {
          await childWf.start();
          await childWf.signal(unblockSignal);
          await childWf.result();
        })();

        if (step === 1) {
          CancellationScope.current().cancel();
        }

        await Promise.all([activityPromise, queryActPromise, timerPromise, childWfPromise, condition(() => unblocked)]);
      });
    } catch (e) {
      if (step !== 1 || !isCancellation(e)) {
        throw e;
      }
    }
  }
}
