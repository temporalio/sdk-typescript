// @@@SNIPSTART nodejs-sleep-workflow
import { sleep } from '@temporalio/workflow';
import { Sleeper } from '../interfaces';

async function execute(ms = 100): Promise<void> {
  await sleep(ms);
  console.log('slept');
}

export const workflow: Sleeper = { execute };
// @@@SNIPEND
