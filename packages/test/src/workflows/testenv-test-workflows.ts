/**
 * Workflows used in `test-testenvironment.ts`
 * @module
 */

import assert from 'assert';
import { sleep, proxyActivities, defineSignal, setHandler } from '@temporalio/workflow';

// Export sleep to be invoked as a workflow
export { sleep };

const activities = proxyActivities({ startToCloseTimeout: 2_000_000 });
export const unblockSignal = defineSignal<[]>('unblock');

export async function raceActivityAndTimer(expectedWinner: 'timer' | 'activity'): Promise<string> {
  const timerShouldWin = expectedWinner === 'timer';
  const timerDuration = timerShouldWin ? 1_000_000 : 1_500_000;
  const activityDuration = timerShouldWin ? 1_500_000 : 1_000_000;
  return await Promise.race([
    sleep(timerDuration).then(() => 'timer'),
    activities.sleep(activityDuration).then(() => 'activity'),
  ]);
}

export async function waitOnSignalWithTimeout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    setHandler(unblockSignal, resolve);
    void sleep(2_000_000).then(() => reject('sleep finished before receiving signal'));
  });
}

export async function assertFromWorkflow(x: number): Promise<void> {
  assert.strictEqual(x, 7);
}
