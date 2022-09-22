/**
 * Tests the various child workflow cancellation types with different timings
 *
 * @module
 */
import { CancelledFailure, ChildWorkflowFailure } from '@temporalio/common';
import { errorMessage } from '@temporalio/common/lib/type-helpers';
import { startChild, CancellationScope, uuid4, getExternalWorkflowHandle } from '@temporalio/workflow';
import { signalTarget } from './signal-target';

export async function childWorkflowCancel(): Promise<void> {
  // Cancellation before sending to server
  try {
    await CancellationScope.cancellable(async () => {
      const promise = startChild(signalTarget);
      CancellationScope.current().cancel();
      await promise;
      throw new Error('ChildWorkflow was not cancelled');
    });
    throw new Error('Expected CancellationScope to throw ChildWorkflowFailure');
  } catch (err) {
    if (!(err instanceof ChildWorkflowFailure && err.cause instanceof CancelledFailure)) {
      throw err;
    }
  }

  // Cancellation of running workflow
  try {
    await CancellationScope.cancellable(async () => {
      const child = await startChild(signalTarget, {});
      CancellationScope.current().cancel();
      await child.result();
      throw new Error('ChildWorkflow was not cancelled');
    });
    throw new Error('Expected CancellationScope to throw ChildWorkflowFailure');
  } catch (err) {
    if (!(err instanceof ChildWorkflowFailure && err.cause instanceof CancelledFailure)) {
      throw err;
    }
  }

  // Cancellation of external workflow
  try {
    const child = await startChild(signalTarget, {});
    const external = getExternalWorkflowHandle(child.workflowId, child.firstExecutionRunId);
    await external.cancel();
    await child.result();
    throw new Error('ChildWorkflow was not cancelled');
  } catch (err) {
    if (!(err instanceof ChildWorkflowFailure && err.cause instanceof CancelledFailure)) {
      throw err;
    }
  }

  // Failed cancellation of external workflow
  try {
    const external = getExternalWorkflowHandle('some-workflow-id-that-doesnt-exist-' + uuid4());
    await external.cancel();
    throw new Error('Cancel did not throw');
  } catch (err) {
    if (errorMessage(err) !== 'Unable to cancel external workflow because not found') {
      throw err;
    }
  }
}
