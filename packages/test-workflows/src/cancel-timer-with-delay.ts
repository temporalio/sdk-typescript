import { CancellationError, cancel, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  const timer = sleep(10000);
  await sleep(1).then(() => cancel(timer));
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
