/**
 * Tests that CancelledError is propagated out of a CancellationScope.
 */
import { CancellationScope, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

export const cancellationErrorIsPropagated: Empty = () => ({
  async execute(): Promise<void> {
    await CancellationScope.cancellable(async () => {
      const promise = sleep(0);
      CancellationScope.current().cancel();
      await promise;
    });
  },
});
