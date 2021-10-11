import { sleep } from './sleep-impl';

export async function importer(): Promise<void> {
  await sleep(10);
  console.log('slept');
}
