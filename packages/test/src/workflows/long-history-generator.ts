import * as wf from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = wf.proxyActivities<typeof activities>({ startToCloseTimeout: '1s' });

/**
 * Simple workflow that generates a lot of sequential activities for testing long histories
 */
export async function longHistoryGenerator(numIterations = 200): Promise<void> {
  for (let i = 0; i < numIterations; ++i) {
    await echo('hello');
  }
}
