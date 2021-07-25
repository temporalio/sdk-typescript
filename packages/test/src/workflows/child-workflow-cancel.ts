/**
 * Tests the various child workflow cancellation types with different timings
 *
 * @module
 */
import { CancelledFailure, ChildWorkflowFailure } from '@temporalio/common';
import { Context, CancellationScope } from '@temporalio/workflow';
import * as sync from './sync';

export async function main(): Promise<void> {
  // Cancellation before sending to server

  try {
    await CancellationScope.cancellable(async () => {
      const child = Context.child<typeof sync>('sync');
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
}
