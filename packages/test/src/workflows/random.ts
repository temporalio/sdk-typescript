import { uuid4, sleep } from '@temporalio/workflow';

export async function random(): Promise<void> {
  console.log(Math.random());
  console.log(uuid4());
  await sleep(1); // Tester should update random seed before resolving this timer
  console.log(Math.random());
}
