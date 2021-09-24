import { sleep } from '@temporalio/workflow';
import { Returner } from '../interfaces';

async function execute(): Promise<string> {
  return await Promise.race([
    sleep(1).then(() => 'first'),
    sleep(1).then(() => {
      // This generates a command that will **not** be executed
      sleep(0);
      return 'second';
    }),
  ]);
}

export const trailingTimer: Returner<string> = () => ({ execute });
