import test from 'ava';
import { CancelledFailure, WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { Activator } from '../internals';
import type { WorkflowCreateOptionsInternal, WorkflowInfo } from '../interfaces';

const targetSeq = 1;
const unrelatedSeq = 2;

function makeActivator(): Activator {
  return new Activator({
    info: {
      namespace: 'default',
      workflowId: 'parent-workflow',
    } as WorkflowInfo,
    randomnessSeed: [1],
    now: 0,
    showStackTraceSources: false,
    sourceMap: {} as WorkflowCreateOptionsInternal['sourceMap'],
    registeredActivityNames: new Set(),
    getTimeOfDay: () => 0n,
    stackTracesEnabled: false,
  });
}

function seedChildWorkflowCompletions(activator: Activator): {
  resolved?: string;
  rejected?: Error;
} {
  const observed: { resolved?: string; rejected?: Error } = {};
  activator.completions.childWorkflowStart.set(targetSeq, {
    resolve(runId) {
      observed.resolved = runId;
    },
    reject(error) {
      observed.rejected = error;
    },
  });
  activator.completions.childWorkflowComplete.set(targetSeq, {
    resolve() {},
    reject() {},
  });
  activator.completions.childWorkflowComplete.set(unrelatedSeq, {
    resolve() {},
    reject() {},
  });
  return observed;
}

test('successful child Workflow start retains its completion', (t) => {
  const activator = makeActivator();
  const observed = seedChildWorkflowCompletions(activator);

  activator.resolveChildWorkflowExecutionStart({
    seq: targetSeq,
    succeeded: { runId: 'child-run-id' },
  });

  t.is(observed.resolved, 'child-run-id');
  t.is(observed.rejected, undefined);
  t.false(activator.completions.childWorkflowStart.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(unrelatedSeq));
});

test('failed child Workflow start removes its completion', (t) => {
  const activator = makeActivator();
  const observed = seedChildWorkflowCompletions(activator);

  activator.resolveChildWorkflowExecutionStart({
    seq: targetSeq,
    failed: {
      cause: 1,
      workflowId: 'child-workflow',
      workflowType: 'childWorkflow',
    },
  });

  t.true(observed.rejected instanceof WorkflowExecutionAlreadyStartedError);
  t.is(observed.resolved, undefined);
  t.false(activator.completions.childWorkflowStart.has(targetSeq));
  t.false(activator.completions.childWorkflowComplete.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(unrelatedSeq));
});

test('cancelled child Workflow start removes its completion', (t) => {
  const activator = makeActivator();
  const observed = seedChildWorkflowCompletions(activator);

  activator.resolveChildWorkflowExecutionStart({
    seq: targetSeq,
    cancelled: {
      failure: {
        message: 'cancelled',
        canceledFailureInfo: {},
      },
    },
  });

  t.true(observed.rejected instanceof CancelledFailure);
  t.is(observed.resolved, undefined);
  t.false(activator.completions.childWorkflowStart.has(targetSeq));
  t.false(activator.completions.childWorkflowComplete.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(unrelatedSeq));
});
