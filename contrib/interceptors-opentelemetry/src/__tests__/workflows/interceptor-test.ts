import { condition, continueAsNew, defineQuery, proxyActivities, proxyLocalActivities, setHandler, startChild } from '@temporalio/workflow';

import type * as activities from '../activities';
import { activityStartedSignal, unblockSignal } from './definitions';
import { signalTarget } from './signal-target';

const { fakeProgress, queryOwnWf } = proxyActivities<typeof activities>({ startToCloseTimeout: '1m' });
const { echo } = proxyLocalActivities<typeof activities>({ startToCloseTimeout: '1m' });

const stepQuery = defineQuery<number>('step');

export async function interceptorTest(iteration = 0): Promise<void> {
  let activityStarted = false;
  setHandler(stepQuery, () => iteration);
  setHandler(activityStartedSignal, () => void (activityStarted = true));

  const child = (async () => {
    const handle = await startChild(signalTarget);
    await handle.signal(unblockSignal);
    await handle.result();
  })();
  await Promise.all([
    fakeProgress(100, 0),
    queryOwnWf(stepQuery),
    child,
    echo('local-activity'),
    condition(() => activityStarted),
  ]);

  if (iteration === 0) {
    await continueAsNew<typeof interceptorTest>(iteration + 1);
  }
}
