/**
 * Tests that scope cancellation is propagated to the workflow while waiting on
 * external workflow cancellation
 *
 * @module
 */
import { CancelledFailure } from '@temporalio/common';
import { CancellationScope, getExternalWorkflowHandle } from '@temporalio/workflow';

export async function scopeCancelledWhileWaitingOnExternalWorkflowCancellation(): Promise<void> {
  try {
    await CancellationScope.cancellable(async () => {
      const handle = getExternalWorkflowHandle('irrelevant');
      const promise = handle.cancel();
      CancellationScope.current().cancel();
      await promise;
      throw new Error('External cancellation was not cancelled');
    });
    throw new Error('Expected CancellationScope to throw ChildWorkflowFailure');
  } catch (err) {
    if (!(err instanceof CancelledFailure)) {
      throw err;
    }
  }
}
