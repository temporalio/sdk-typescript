import { sleep } from '@temporalio/workflow';
import { Returner } from '../interfaces';

async function execute(): Promise<string> {
  return await Promise.race([
    sleep(1).then(() => 'first'),
    sleep(1).then(() => {
      // This should never be executed
      console.log('trailing timer triggered after workflow completed');
      sleep(0);
      return 'second';
    }),
  ]);
}

export const trailingTimer: Returner<string> = () => ({ execute });
