import { CancelledFailure, CancellationScope, sleep } from '@temporalio/workflow';

export async function cancelTimerWithDelay(): Promise<void> {
  const scope = new CancellationScope();
  const promise = scope.run(() => sleep(10000));
  await sleep(1).then(() => scope.cancel());
  try {
    await promise;
  } catch (e) {
    if (e instanceof CancelledFailure) {
      console.log('Timer cancelled 👍');
    } else {
      throw e;
    }
  }
}
