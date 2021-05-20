import '@temporalio/workflow';
import { sleep } from './sleep-impl';

export async function main(): Promise<void> {
  await sleep(10);
  console.log('slept');
}
