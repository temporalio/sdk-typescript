import { CancellationScope, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

export const shieldInShield: Empty = () => ({
  async execute(): Promise<void> {
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
  },
});
