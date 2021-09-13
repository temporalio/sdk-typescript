// @@@SNIPSTART nodejs-sleep-workflow
import { sleep } from '@temporalio/workflow';
import { Sleeper } from '../interfaces';

export const sleeper: Sleeper = (ms = 100) => ({
  async execute(): Promise<void> {
    await sleep(ms);
    console.log('slept');
  },
});
// @@@SNIPEND
