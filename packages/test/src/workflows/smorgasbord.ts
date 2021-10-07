/**
 * This workflow does a little bit of everything
 */
import {
  Trigger,
  sleep,
  createChildWorkflowHandle,
  createActivityHandle,
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';
import { Smorgasbord } from '../interfaces';
import * as activities from '../activities/';
import { signalTarget } from './signal-target';

const { fakeProgress } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '5s',
  scheduleToCloseTimeout: '10s',
  heartbeatTimeout: '3s',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export const smorgasbord: Smorgasbord = () => {
  let step = 0;
  const unblocked = new Trigger<void>();

  return {
    queries: {
      step(): number {
        return step;
      },
    },
    signals: {
      activityStarted(): void {
        unblocked.resolve();
      },
    },

    async execute(): Promise<void> {
      while (step < 2) {
        try {
          await CancellationScope.cancellable(async () => {
            const activityPromise = fakeProgress(100, 10);
            const timerPromise = sleep(1000);

            const childWf = createChildWorkflowHandle(signalTarget);
            const childWfPromise = (async () => {
              await childWf.start();
              await childWf.signal.unblock();
              await childWf.result();
            })();

            step += 1;

            if (step === 2) {
              CancellationScope.current().cancel();
            }

            await Promise.all([activityPromise, timerPromise, childWfPromise, unblocked]);
          });
        } catch (e) {
          if (step !== 2 || !isCancellation(e)) {
            throw e;
          }
        }
      }
    },
  };
};
