/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import anyTest, { Constructor, Macro, TestInterface } from 'ava';
import { WorkflowClient, WorkflowExecutionCancelledError, WorkflowExecutionFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import {
  WorkflowCancellationScenarioOutcome,
  WorkflowCancellationScenarioTiming,
  WorkflowCancellationScenarios,
} from './interfaces';
import { RUN_INTEGRATION_TESTS } from './helpers';

export interface Context {
  worker: Worker;
  runPromise: Promise<void>;
}

const test = anyTest as TestInterface<Context>;
const taskQueue = 'test-cancellation';

const testWorkflowCancellation: Macro<
  [WorkflowCancellationScenarioOutcome, WorkflowCancellationScenarioTiming, Constructor | undefined],
  Context
> = async (t, outcome, timing, expected) => {
  const client = new WorkflowClient();
  const workflow = client.stub<WorkflowCancellationScenarios>('workflow-cancellation-scenarios', { taskQueue });
  await workflow.start(outcome, timing);
  await workflow.cancel();
  if (expected === undefined) {
    await workflow.result();
    t.pass();
  } else {
    await t.throwsAsync(workflow.result(), {
      instanceOf: expected,
    });
  }
};

testWorkflowCancellation.title = (_providedTitle = '', outcome, timing) =>
  `workflow cancellation scenario ${outcome} ${timing}`;

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const worker = await Worker.create({
      workflowsPath: `${__dirname}/workflows`,
      activitiesPath: `${__dirname}/activities`,
      nodeModulesPath: `${__dirname}/../../../node_modules`,
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
  test(testWorkflowCancellation, 'cancel', 'immediately', WorkflowExecutionCancelledError);
  test(testWorkflowCancellation, 'cancel', 'after-cleanup', WorkflowExecutionCancelledError);
  test(testWorkflowCancellation, 'fail', 'immediately', WorkflowExecutionFailedError);
  test(testWorkflowCancellation, 'fail', 'after-cleanup', WorkflowExecutionFailedError);
}
