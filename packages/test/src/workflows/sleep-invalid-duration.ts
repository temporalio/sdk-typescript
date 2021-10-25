import { sleep } from '@temporalio/workflow';

export async function sleepInvalidDuration(): Promise<void> {
  await sleep(0);
  await new Promise((resolve) => setTimeout(resolve, -1));
}
