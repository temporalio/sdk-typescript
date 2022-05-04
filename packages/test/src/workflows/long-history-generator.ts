import * as wf from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = wf.proxyActivities<typeof activities>({ startToCloseTimeout: '1s' });

/**
 * Simple workflow that generates a lot of sequential activities for testing long histories
 */
export async function longHistoryGenerator(numIterations = 200, pauseAfterCompletion = true): Promise<void> {
  let i = 0;
  wf.setHandler(wf.defineQuery('iteration'), () => i);

  for (; i < numIterations; ++i) {
    await echo('hello');
  }
  if (pauseAfterCompletion) {
    await wf.CancellationScope.current().cancelRequested;
  }
}
