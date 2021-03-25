import { sleep } from '@temporalio/workflow';
import { Empty } from '@interfaces';

async function main(): Promise<void> {
  await sleep(100);
  console.log('slept');
}

export const workflow: Empty = { main };
