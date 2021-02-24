import '@temporalio/workflow';
import { sleep } from './sleep';

export async function main(): Promise<void> {
  await sleep(10);
  console.log('slept');
}
