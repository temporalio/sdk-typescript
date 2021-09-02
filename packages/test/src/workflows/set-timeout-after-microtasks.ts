import { sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function delayedSleep(ms: number) {
  await Promise.resolve();
  await sleep(ms);
}

async function execute(): Promise<void> {
  await delayedSleep(100);
  console.log('slept');
}

export const setTimeoutAfterMicroTasks: Empty = () => ({ execute });
