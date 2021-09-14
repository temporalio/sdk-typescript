/**
 * Tests the various child workflow cancellation types with different timings
 *
 * @module
 */
import { CancelledFailure, ChildWorkflowFailure, errorMessage } from '@temporalio/common';
import {
  createChildWorkflowHandle,
  CancellationScope,
  uuid4,
  createExternalWorkflowHandle,
} from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { signalTarget } from './signal-target';

export const childWorkflowCancel: Empty = () => ({
  async execute(): Promise<void> {
    // Cancellation before sending to server
    try {
      await CancellationScope.cancellable(async () => {
        const child = createChildWorkflowHandle(signalTarget);
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
        const child = createChildWorkflowHandle(signalTarget);
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
      const child = createChildWorkflowHandle(signalTarget);
      const runId = await child.start();
      const external = createExternalWorkflowHandle<typeof signalTarget>(child.workflowId, runId);
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
      const external = createExternalWorkflowHandle<typeof signalTarget>(
        'some-workflow-id-that-doesnt-exist-' + uuid4()
      );
      await external.cancel();
      throw new Error('Cancel did not throw');
    } catch (err) {
      if (errorMessage(err) !== 'Unable to cancel external workflow because not found') {
        throw err;
      }
    }
  },
});
