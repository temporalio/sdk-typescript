/**
 * Tests the various child workflow cancellation types with different timings
 *
 * @module
 */
import { CancelledFailure, ChildWorkflowFailure } from '@temporalio/common';
import { Context, CancellationScope, uuid4 } from '@temporalio/workflow';
import { workflow as unblockable } from './signal-target';

export async function main(): Promise<void> {
  // Cancellation before sending to server
  try {
    await CancellationScope.cancellable(async () => {
      const child = Context.child<typeof unblockable>('signal-target');
      const promise = child.start();
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
      const child = Context.child<typeof unblockable>('signal-target');
      await child.start();
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
    const child = Context.child<typeof unblockable>('signal-target');
    const runId = await child.start();
    const external = Context.external<typeof unblockable>(child.workflowId, runId);
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
    const external = Context.external<typeof unblockable>('some-workflow-id-that-doesnt-exist-' + uuid4());
    await external.cancel();
    throw new Error('Cancel did not throw');
  } catch (err) {
    if (err.message !== 'Unable to cancel external workflow because not found') {
      throw err;
    }
  }
}
