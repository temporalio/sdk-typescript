import { sleep } from '@temporalio/workflow';

async function delayedSleep(ms: number) {
  await Promise.resolve();
  await sleep(ms);
}

export async function main(): Promise<void> {
  await delayedSleep(100);
  console.log('slept');
}
