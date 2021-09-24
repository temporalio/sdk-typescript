/**
 * Tests child workflow signaling - failure, success and cancellation
 * @module
 */

import {
  CancellationScope,
  createChildWorkflowHandle,
  createExternalWorkflowHandle,
  isCancellation,
  rootCause,
  uuid4,
} from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { signalTarget } from './signal-target';

/**
 * If this workflow completes successfully, it should make the test pass
 */
export const childWorkflowSignals: Empty = () => ({
  async execute(): Promise<void> {
    /// Signal child WF tests
    {
      // Happy path
      const child = createChildWorkflowHandle(signalTarget);
      await child.start();
      await child.signal.unblock();
      await child.result();
    }
    {
      // Cancel signal
      const child = createChildWorkflowHandle(signalTarget);
      await child.start();

      try {
        await CancellationScope.cancellable(async () => {
          const p = child.signal.fail('You have failed me for the last time');
          CancellationScope.current().cancel();
          await p;
        });
        throw new Error('Signal did not throw');
      } catch (err) {
        if (!isCancellation(err)) {
          throw err;
        }
      }

      // Allow child to complete - note that if the fail signal was not cancelled the
      // child would have failed instead of completing successfully
      await Promise.all([child.signal.unblock(), child.result()]);
    }
    {
      // Signal before start
      const child = createChildWorkflowHandle(signalTarget);
      try {
        await child.signal.unblock();
        throw new Error('Signal did not throw');
      } catch (err: any) {
        if (err.name !== 'IllegalStateError' || err.message !== 'Workflow execution not started') {
          throw err;
        }
      }
    }

    /// Signal external WF tests
    {
      // Happy path
      const child = createChildWorkflowHandle(signalTarget);
      const runId = await child.start();
      const external = createExternalWorkflowHandle<typeof signalTarget>(child.workflowId, runId);
      await external.signal.unblock();
      await child.result();
    }
    {
      // Cancel signal
      const child = createChildWorkflowHandle(signalTarget);
      const runId = await child.start();
      const external = createExternalWorkflowHandle<typeof signalTarget>(child.workflowId, runId);

      try {
        await CancellationScope.cancellable(async () => {
          const p = external.signal.fail('You have failed me for the last time');
          CancellationScope.current().cancel();
          await p;
        });
        throw new Error('Signal did not throw');
      } catch (err) {
        if (!isCancellation(err)) {
          throw err;
        }
      }

      // Allow child to complete - note that if the fail signal was not cancelled the
      // child would have failed instead of completing successfully
      await Promise.all([external.signal.unblock(), child.result()]);
    }
    {
      // No such WF
      const external = createExternalWorkflowHandle<typeof signalTarget>(
        'some-workflow-id-that-doesnt-exist-' + uuid4()
      );

      try {
        await external.signal.unblock();
        throw new Error('Signal did not throw');
      } catch (err) {
        if (rootCause(err) !== 'Unable to signal external workflow because it was not found') {
          throw err;
        }
      }
    }
  },
});
