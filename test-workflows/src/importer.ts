import '@temporal-sdk/workflow';
import { sleep } from './sleep';

export async function main() {
  await sleep(10);
  console.log('slept');
}
