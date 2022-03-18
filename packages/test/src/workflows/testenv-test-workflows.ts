/**
 * Workflows used in `test-testenvironment.ts`
 * @module
 */

import assert from 'assert';
import { sleep, proxyActivities } from '@temporalio/workflow';

// Export sleep to be invoked as a workflow
export { sleep };

const activities = proxyActivities({ startToCloseTimeout: 2_000_000 });

export async function raceActivityAndTimer(expectedWinner: 'timer' | 'activity'): Promise<string> {
  const timerShouldWin = expectedWinner === 'timer';
  const timerDuration = timerShouldWin ? 1_000_000 : 1_500_000;
  const activityDuration = timerShouldWin ? 1_500_000 : 1_000_000;
  return await Promise.race([
    sleep(timerDuration).then(() => 'timer'),
    activities.sleep(activityDuration).then(() => 'activity'),
  ]);
}

export async function assertFromWorkflow(x: number): Promise<void> {
  assert.strictEqual(x, 7);
}
