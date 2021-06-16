import { CancelledError, CancellationScope, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function main(): Promise<void> {
  const scope = new CancellationScope();
  const promise = scope.run(() => sleep(10000));
  await sleep(1).then(() => scope.cancel());
  try {
    await promise;
  } catch (e) {
    if (e instanceof CancelledError) {
      console.log('Timer cancelled 👍');
    } else {
      throw e;
    }
  }
}

export const workflow: Empty = { main };
