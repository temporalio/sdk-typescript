import { CancellationError, cancel, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function main(): Promise<void> {
  const timer = sleep(3);
  cancel(timer);
  try {
    await timer;
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Timer cancelled 👍');
    } else {
      throw e;
    }
  }
}

export const workflow: Empty = { main };
