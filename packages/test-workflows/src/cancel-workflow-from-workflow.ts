import { CancellationError, Context, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  const timer = sleep(3);
  Context.cancel();
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
