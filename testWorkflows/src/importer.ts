import '@temporal-sdk/workflow';
import { sleep } from './sleep';

export async function main() {
  await sleep(1000);
  console.log('slept');
}
