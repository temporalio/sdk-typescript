import test from 'ava';
import { Activator } from '../internals';
import type { coresdk } from '@temporalio/proto';
import type { WorkflowInfo, WorkflowCreateOptionsInternal } from '../interfaces';

function createActivator(): Activator {
  const opts: WorkflowCreateOptionsInternal = {
    info: {
      workflowId: 'test-workflow',
      runId: 'test-run-id',
      taskQueue: 'test-task-queue',
      namespace: 'default',
      startTime: Date.now(),
      runStartTime: Date.now(),
      attempt: 1,
      cronSchedule: undefined,
      continueAsNewSuggested: false,
      isReplaying: false,
      unsafe: {} as WorkflowInfo['unsafe'],
    } as WorkflowInfo,
    randomnessSeed: [1, 2, 3],
    now: Date.now(),
    showStackTraceSources: false,
    sourceMap: {} as any,
    registeredActivityNames: new Set(),
    getTimeOfDay: () => BigInt(Date.now()),
    stackTracesEnabled: false,
  };
  return new Activator(opts);
}

test('resolveChildWorkflowExecutionStart cleans up childWorkflowComplete on failed start', (t) => {
  const activator = createActivator();
  const seq = 1;

  // Simulate what startChildWorkflowExecutionNextHandler does:
  // It sets both childWorkflowStart and childWorkflowComplete entries
  const startResolve = () => {};
  const startReject = () => {};
  activator.completions.childWorkflowStart.set(seq, {
    resolve: startResolve,
    reject: startReject,
    context: undefined,
  });

  const completeResolve = () => {};
  const completeReject = () => {};
  activator.completions.childWorkflowComplete.set(seq, {
    resolve: completeResolve,
    reject: completeReject,
    context: undefined,
  });

  // Verify both entries exist before the call
  t.true(activator.completions.childWorkflowStart.has(seq));
  t.true(activator.completions.childWorkflowComplete.has(seq));

  // Simulate a failed start activation
  const activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart = {
    seq,
    failed: {
      cause: coresdk.child_workflow.StartChildWorkflowExecutionFailedCause.START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_WORKFLOW_ALREADY_EXISTS,
      workflowId: 'duplicate-workflow-id',
      workflowType: 'test-workflow',
    },
  };

  // This should consume the childWorkflowStart entry AND clean up childWorkflowComplete
  activator.resolveChildWorkflowExecutionStart(activation);

  // Verify childWorkflowStart was consumed (removed)
  t.false(activator.completions.childWorkflowStart.has(seq));

  // Verify childWorkflowComplete was cleaned up (removed)
  t.false(activator.completions.childWorkflowComplete.has(seq));
});

test('resolveChildWorkflowExecutionStart cleans up childWorkflowComplete on cancelled start', (t) => {
  const activator = createActivator();
  const seq = 2;

  // Simulate what startChildWorkflowExecutionNextHandler does
  activator.completions.childWorkflowStart.set(seq, {
    resolve: () => {},
    reject: () => {},
    context: undefined,
  });

  activator.completions.childWorkflowComplete.set(seq, {
    resolve: () => {},
    reject: () => {},
    context: undefined,
  });

  // Verify both entries exist before the call
  t.true(activator.completions.childWorkflowStart.has(seq));
  t.true(activator.completions.childWorkflowComplete.has(seq));

  // Simulate a cancelled start activation
  const activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart = {
    seq,
    cancelled: {
      failure: {
        message: 'cancelled',
        source: 'test',
        stackTrace: '',
      },
    },
  };

  activator.resolveChildWorkflowExecutionStart(activation);

  // Verify childWorkflowStart was consumed
  t.false(activator.completions.childWorkflowStart.has(seq));

  // Verify childWorkflowComplete was cleaned up
  t.false(activator.completions.childWorkflowComplete.has(seq));
});

test('resolveChildWorkflowExecutionStart does NOT remove childWorkflowComplete on succeeded start', (t) => {
  const activator = createActivator();
  const seq = 3;

  // Simulate what startChildWorkflowExecutionNextHandler does
  activator.completions.childWorkflowStart.set(seq, {
    resolve: () => {},
    reject: () => {},
    context: undefined,
  });

  activator.completions.childWorkflowComplete.set(seq, {
    resolve: () => {},
    reject: () => {},
    context: undefined,
  });

  // Simulate a succeeded start activation
  const activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart = {
    seq,
    succeeded: {
      runId: 'child-run-id',
    },
  };

  activator.resolveChildWorkflowExecutionStart(activation);

  // childWorkflowStart should be consumed
  t.false(activator.completions.childWorkflowStart.has(seq));

  // childWorkflowComplete should still exist (will be consumed later by resolveChildWorkflowExecution)
  t.true(activator.completions.childWorkflowComplete.has(seq));
});
