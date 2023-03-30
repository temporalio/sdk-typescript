import { startChild, sleep, proxyActivities } from '@temporalio/workflow';
import { successString } from './success-string';
import type * as activities from '../activities';

const { sleepFor } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function timeTravelStacks(): Promise<void> {
  const child = await startChild(successString, {});

  for (let i = 0; i < 5; i++) {
    const sleepin = sleep(1);
    const act = sleepFor(500);
    await Promise.race([sleepin, act]);
  }

  await child.result();
}
