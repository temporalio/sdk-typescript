import { Empty } from '../interfaces';
import { sleep } from './sleep-impl';

async function execute(): Promise<void> {
  await sleep(10);
  console.log('slept');
}

export const importer: Empty = () => ({ execute });
