import { sleep } from '@temporalio/workflow';
import { SetTimeout } from '@interfaces';

async function main(ms = 100): Promise<void> {
  await sleep(ms);
  console.log('slept');
}

export const workflow: SetTimeout = { main };
