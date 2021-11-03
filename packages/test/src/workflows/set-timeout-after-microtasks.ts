import { sleep } from '@temporalio/workflow';

async function delayedSleep(ms: number) {
  await Promise.resolve();
  await sleep(ms);
}

export async function setTimeoutAfterMicroTasks(): Promise<void> {
  await delayedSleep(100);
  console.log('slept');
}
