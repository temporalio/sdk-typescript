import { Macro, ErrorConstructor } from 'ava';
import { CancellationScope, sleep } from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { makeTestFunction, Context, helpers } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test workflow cancellation scenarios

type WorkflowCancellationScenarioOutcome = 'complete' | 'cancel' | 'fail';
type WorkflowCancellationScenarioTiming = 'immediately' | 'after-cleanup';

export async function workflowCancellationScenariosWorkflow(
  outcome: WorkflowCancellationScenarioOutcome,
  when: WorkflowCancellationScenarioTiming
): Promise<void> {
  try {
    await CancellationScope.current().cancelRequested;
  } catch (e) {
    if (!(e instanceof CancelledFailure)) {
      throw e;
    }
    if (when === 'after-cleanup') {
      await CancellationScope.nonCancellable(async () => sleep(1));
    }
    switch (outcome) {
      case 'cancel':
        throw e;
      case 'complete':
        return;
      case 'fail':
        throw ApplicationFailure.nonRetryable('Expected failure');
    }
  }
}

const testWorkflowCancellation: Macro<
  [WorkflowCancellationScenarioOutcome, WorkflowCancellationScenarioTiming, ErrorConstructor | undefined],
  Context
> = {
  exec: async (t, outcome, timing, expected) => {
    const { createWorker, startWorkflow } = helpers(t);

    const worker = await createWorker({});

    await worker.runUntil(async () => {
      const workflow = await startWorkflow(workflowCancellationScenariosWorkflow, {
        args: [outcome, timing],
      });
      await workflow.cancel();
      if (expected === undefined) {
        await workflow.result();
        t.pass();
      } else {
        const err = await t.throwsAsync(workflow.result(), {
          instanceOf: WorkflowFailedError,
        });
        if (!(err instanceof WorkflowFailedError)) {
          throw new Error('Unreachable');
        }
        t.true(err.cause instanceof expected);
      }
    });
  },
  title: (_providedTitle = '', outcome, timing) => `workflow cancellation scenario ${outcome} ${timing}`,
};

test(testWorkflowCancellation, 'complete', 'immediately', undefined);
test(testWorkflowCancellation, 'complete', 'after-cleanup', undefined);
test(testWorkflowCancellation, 'cancel', 'immediately', CancelledFailure);
test(testWorkflowCancellation, 'cancel', 'after-cleanup', CancelledFailure);
test(testWorkflowCancellation, 'fail', 'immediately', ApplicationFailure);
test(testWorkflowCancellation, 'fail', 'after-cleanup', ApplicationFailure);
