// @@@SNIPSTART nodejs-sleep-workflow
import { sleep } from '@temporalio/workflow';

export async function sleeper(ms = 100): Promise<void> {
  await sleep(ms);
  console.log('slept');
}
// @@@SNIPEND
