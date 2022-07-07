import * as wf from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = wf.proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

/**
 * Reproduces https://github.com/temporalio/sdk-typescript/issues/731
 */
export async function issue731() {
  await wf.CancellationScope.cancellable(async () => {
    const localActivityPromise = echo('activity');
    const sleepPromise = wf.sleep('30s').then(() => 'timer');
    const result = await Promise.race([localActivityPromise, sleepPromise]);
    if (result === 'timer') {
      throw wf.ApplicationFailure.nonRetryable('Timer unexpectedly beat local activity');
    }
    wf.CancellationScope.current().cancel();
  });

  await wf.sleep(100);
}
