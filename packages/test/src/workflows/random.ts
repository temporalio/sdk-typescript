import { uuid4, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  console.log(Math.random());
  console.log(uuid4());
  await sleep(1); // Tester should update random seed before resolving this timer
  console.log(Math.random());
}

export const random: Empty = () => ({ execute });
