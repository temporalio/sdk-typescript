import { sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  await sleep(100);
  console.log('slept');
}
