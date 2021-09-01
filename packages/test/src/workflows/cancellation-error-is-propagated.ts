/**
 * Tests that CancelledError is propagated out of a CancellationScope.
 */
import { CancellationScope, sleep } from '@temporalio/workflow';

export async function execute(): Promise<void> {
  await CancellationScope.cancellable(async () => {
    const promise = sleep(0);
    CancellationScope.current().cancel();
    await promise;
  });
}
