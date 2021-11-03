import { CancellationScope, sleep } from '@temporalio/workflow';

export async function shieldInShield(): Promise<void> {
  await CancellationScope.nonCancellable(async () => {
    const timer = sleep(2);
    const child = CancellationScope.nonCancellable(async () => {
      const promise = sleep(1);
      CancellationScope.current().cancel();
      await promise;
      console.log('Timer 1 finished 👍');
    });
    await child;
    await timer;
    console.log('Timer 0 finished 👍');
  });
}
