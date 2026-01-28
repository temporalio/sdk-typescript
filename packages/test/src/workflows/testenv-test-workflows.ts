/**
 * Workflows used in `test-testenvironment-timeskipping.ts`
 * @module
 */

import assert from 'assert';
import { sleep, proxyActivities, defineSignal, setHandler, startChild } from '@temporalio/workflow';

// Export sleep to be invoked as a workflow
export { sleep };

interface Activities {
  sleep(duration: number): Promise<void>;
}

const activities = proxyActivities<Activities>({ startToCloseTimeout: 2_000_000 });
export const unblockSignal = defineSignal<[]>('unblock');

export async function raceActivityAndTimer(expectedWinner: 'timer' | 'activity'): Promise<string> {
  const timerShouldWin = expectedWinner === 'timer';
  const timerDuration = timerShouldWin ? 1_000_000 : 1_500_000;
  const activityDuration = timerShouldWin ? 1_500_000 : 1_000_000;

  const timerPromise = sleep(timerDuration).then(() => 'timer');
  const activityPromise = activities.sleep(activityDuration).then(() => 'activity');
  const winner = await Promise.race([timerPromise, activityPromise]);

  // TODO: there's an issue with the Java test server where if an activity does not complete
  // before its scheduling workflow, time skipping stays locked, thus potentially causing errors
  // on later tests. Work around this by making sure activity is completed before returning.
  // See https://github.com/temporalio/sdk-java/issues/1138
  await activityPromise;

  return winner;
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

export async function asyncChildStarter(childWorkflowId: string): Promise<void> {
  await startChild(sleep, {
    args: ['1 day'],
    workflowId: childWorkflowId,
    parentClosePolicy: 'ABANDON',
  });
}
