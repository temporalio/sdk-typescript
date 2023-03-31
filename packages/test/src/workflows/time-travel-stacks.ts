import { startChild, sleep, proxyActivities } from '@temporalio/workflow';
import { successString } from './success-string';
import type * as activities from '../activities';
import { sleeper } from './sleep';

const { sleepFor } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function timeTravelStacks(): Promise<void> {
  const first = sleep('1 second');
  // This guy should show up as another stack
  const thirdRoutine = otherRoutine();
  const longActivity = sleepFor('5 seconds');
  const childSecond = await startChild(sleeper, { args: [2000] });

  // This all should show up as the line in four workflow tasks:
  // 1. Nothing resolved
  // 2. first resolved
  // 3. first and childSecond resolved
  // 4. first, childSecond, and thirdRoutine resolved
  await Promise.all([first, childSecond.result(), thirdRoutine]);

  // This should be waited on still after the above resolves
  await longActivity;
}

async function otherRoutine(): Promise<void> {
  await sleep('3 seconds');
}

export async function enhancedStackStuck(): Promise<void> {
  const child = await startChild(successString, {});

  for (let i = 0; i < 5; i++) {
    const sleepin = sleep(1);
    const act = sleepFor(500);
    await Promise.all([sleepin, act]);
  }

  await Promise.all([child.result(), sleep(1), sleep(100), sleepFor('1 day')]);
}
