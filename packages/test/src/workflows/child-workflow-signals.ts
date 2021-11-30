/**
 * Tests child workflow signaling - failure, success and cancellation
 * @module
 */

import {
  CancellationScope,
  startChild,
  getExternalWorkflowHandle,
  isCancellation,
  rootCause,
  uuid4,
} from '@temporalio/workflow';
import { signalTarget } from './signal-target';
import { argsTestSignal, unblockSignal, failWithMessageSignal } from './definitions';

/**
 * If this workflow completes successfully, it should make the test pass
 */
export async function childWorkflowSignals(): Promise<void> {
  /// Signal child WF tests
  {
    // Happy path
    const child = await startChild(signalTarget, {});
    // Args are transferred correctly
    await child.signal(argsTestSignal, 123, 'kid');
    await child.signal(unblockSignal);
    await child.result();
  }
  {
    // Cancel signal
    const child = await startChild(signalTarget, {});

    try {
      await CancellationScope.cancellable(async () => {
        const p = child.signal(failWithMessageSignal, 'You have failed me for the last time');
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
    await Promise.all([child.signal(unblockSignal), child.result()]);
  }

  /// Signal external WF tests
  {
    // Happy path
    const child = await startChild(signalTarget, {});
    const external = getExternalWorkflowHandle(child.workflowId, child.originalRunId);
    // Args are transferred correctly
    await external.signal(argsTestSignal, 123, 'kid');
    await external.signal(unblockSignal);
    await child.result();
  }
  {
    // Cancel signal
    const child = await startChild(signalTarget, {});
    const external = getExternalWorkflowHandle(child.workflowId, child.originalRunId);

    try {
      await CancellationScope.cancellable(async () => {
        const p = external.signal(failWithMessageSignal, 'You have failed me for the last time');
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
    await Promise.all([external.signal(unblockSignal), child.result()]);
  }
  {
    // No such WF
    const external = getExternalWorkflowHandle('some-workflow-id-that-doesnt-exist-' + uuid4());

    try {
      await external.signal(unblockSignal);
      throw new Error('Signal did not throw');
    } catch (err) {
      if (rootCause(err) !== 'Unable to signal external workflow because it was not found') {
        throw err;
      }
    }
  }
}
