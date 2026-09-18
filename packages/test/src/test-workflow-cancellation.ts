import type { Macro, ErrorConstructor } from 'ava';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { Context } from './helpers-integration';
import { makeTestFunction, helpers } from './helpers-integration';
import {
  type WorkflowCancellationScenarioOutcome,
  type WorkflowCancellationScenarioTiming,
  workflowCancellationScenariosWorkflow,
} from './workflows/workflow-cancellation';

const test = makeTestFunction({});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test workflow cancellation scenarios

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
        t.true(err!.cause instanceof expected);
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
