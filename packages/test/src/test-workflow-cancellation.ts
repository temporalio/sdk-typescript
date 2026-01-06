import type { Macro, TestFn, ErrorConstructor } from 'ava';
import anyTest from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import * as activities from './activities';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import type { WorkflowCancellationScenarioOutcome, WorkflowCancellationScenarioTiming } from './workflows';
import { workflowCancellationScenarios } from './workflows';

export interface Context {
  worker: Worker;
  runPromise: Promise<void>;
}

const test = anyTest as TestFn<Context>;
const taskQueue = 'test-cancellation';

const testWorkflowCancellation: Macro<
  [WorkflowCancellationScenarioOutcome, WorkflowCancellationScenarioTiming, ErrorConstructor | undefined],
  Context
> = {
  exec: async (t, outcome, timing, expected) => {
    const client = new WorkflowClient();
    const workflow = await client.start(workflowCancellationScenarios, {
      args: [outcome, timing],
      taskQueue,
      workflowId: uuid4(),
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
  },
  title: (_providedTitle = '', outcome, timing) => `workflow cancellation scenario ${outcome} ${timing}`,
};

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
    });

    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    t.context = { worker, runPromise };
  });

  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test(testWorkflowCancellation, 'complete', 'immediately', undefined);
  test(testWorkflowCancellation, 'complete', 'after-cleanup', undefined);
  test(testWorkflowCancellation, 'cancel', 'immediately', CancelledFailure);
  test(testWorkflowCancellation, 'cancel', 'after-cleanup', CancelledFailure);
  test(testWorkflowCancellation, 'fail', 'immediately', ApplicationFailure);
  test(testWorkflowCancellation, 'fail', 'after-cleanup', ApplicationFailure);
}
