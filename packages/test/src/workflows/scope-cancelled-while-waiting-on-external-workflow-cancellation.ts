/**
 * Tests that scope cancellation is propagated to the workflow while waiting on
 * external workflow cancellation (`await ExternalWorkflowHandle.cancel()`).
 *
 * This test was added along with the behavior fix where waiting for external
 * workflow cancellation was the only framework generated promise that was not
 * connected to a a cancellation scope.
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
    throw new Error('Expected CancellationScope to throw CancelledFailure');
  } catch (err) {
    if (!(err instanceof CancelledFailure)) {
      throw err;
    }
  }
}
