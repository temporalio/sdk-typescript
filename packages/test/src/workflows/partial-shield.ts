import { CancelledFailure, CancellationScope, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

export const partialShield: Empty = () => ({
  async execute() {
    try {
      await Promise.all([
        CancellationScope.nonCancellable(async () => {
          await sleep(5);
          await sleep(1);
        }),
        (async () => {
          await sleep(3);
          await sleep(2);
        })(),
      ]);
    } catch (e) {
      if (e instanceof CancelledFailure) {
        console.log('Workflow cancelled');
      }
      // Let the shielded sleep be triggered before completion
      await CancellationScope.nonCancellable(() => sleep(10));
    }
  },
});
