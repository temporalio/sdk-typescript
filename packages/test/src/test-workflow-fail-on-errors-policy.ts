import asyncRetry from 'async-retry';
import type { WorkflowHandle } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import * as workflow from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
});

////////////////////////////////////////////////////////////////////////////////
// Test fixtures: custom error classes and workflows
////////////////////////////////////////////////////////////////////////////////

export class CustomWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomWorkflowError';
  }
}

export class CustomWorkflowSubError extends CustomWorkflowError {
  constructor(message: string) {
    super(message);
    this.name = 'CustomWorkflowSubError';
  }
}

export async function throwCustomError(): Promise<void> {
  throw new CustomWorkflowError('custom error');
}

export async function throwCustomSubError(): Promise<void> {
  throw new CustomWorkflowSubError('custom sub error');
}

export async function throwPlainError(): Promise<void> {
  throw new Error('plain error');
}

export async function throwCustomErrorWithDefinitionOptions(): Promise<void> {
  throw new CustomWorkflowError('custom error from definition options');
}
workflow.setWorkflowOptions({ failureExceptionTypes: [CustomWorkflowError] }, throwCustomErrorWithDefinitionOptions);

export async function throwSubErrorWithParentInDefinitionOptions(): Promise<void> {
  throw new CustomWorkflowSubError('sub error with parent in definition options');
}
workflow.setWorkflowOptions(
  { failureExceptionTypes: [CustomWorkflowError] },
  throwSubErrorWithParentInDefinitionOptions
);

/**
 * Forces a non-determinism error by branching on `unsafe.isReplaying`. The
 * first execution issues a `startTimer` command; on the next WFT, replay
 * (forced via `maxCachedWorkflows: 0`) takes the no-command branch, which
 * mismatches the recorded history.
 */
export async function nondeterministicWorkflow(): Promise<void> {
  if (!workflow.workflowInfo().unsafe.isReplaying) {
    await workflow.sleep('1ms');
  }
}

////////////////////////////////////////////////////////////////////////////////
// Helpers
////////////////////////////////////////////////////////////////////////////////

/**
 * Polls workflow history until a `WorkflowTaskFailed` event referencing the
 * given error type/message is observed, then terminates the workflow. This is
 * how we assert "default WFT failure" behavior: the workflow remains running
 * (retrying the task) rather than failing the execution outright.
 */
async function assertWftFailureAndTerminate(
  handle: WorkflowHandle,
  expected: { messageContains?: string; errorType?: string }
): Promise<void> {
  try {
    await asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        const wftFailedEvent = history.events?.findLast((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WorkflowTaskFailed event found yet');
        }
        const { failure } = wftFailedEvent.workflowTaskFailedEventAttributes ?? {};
        if (!failure) {
          throw new Error('Expected `failure` in workflowTaskFailedEventAttributes');
        }
        if (expected.messageContains && !failure.message?.includes(expected.messageContains)) {
          throw new Error(
            `Expected failure message to contain ${JSON.stringify(expected.messageContains)}, got ${JSON.stringify(
              failure.message
            )}`
          );
        }
        if (expected.errorType && failure.applicationFailureInfo?.type !== expected.errorType) {
          throw new Error(
            `Expected applicationFailureInfo.type=${JSON.stringify(expected.errorType)}, got ${JSON.stringify(
              failure.applicationFailureInfo?.type
            )}`
          );
        }
      },
      { minTimeout: 300, factor: 1, retries: 15 }
    );
  } finally {
    await handle.terminate().catch(() => {
      /* ignore */
    });
  }
}

////////////////////////////////////////////////////////////////////////////////
// Tests for workflowFailureErrorTypes / WorkflowDefinitionOptions.failureExceptionTypes
////////////////////////////////////////////////////////////////////////////////

// Default behavior: non-TemporalFailure errors cause Workflow Task failure (not execution failure)
test('failureExceptionTypes - default causes WFT failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(throwCustomError);
    await assertWftFailureAndTerminate(handle, { messageContains: 'custom error' });
    t.pass();
  });
});

// WorkerOptions path: workflowFailureErrorTypes causes execution failure (exact class name match)
test('failureExceptionTypes - WorkerOptions causes WF execution failure', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    workflowFailureErrorTypes: { '*': ['CustomWorkflowError'] },
  });
  await worker.runUntil(async () => {
    const err = (await t.throwsAsync(executeWorkflow(throwCustomError), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is(err.cause?.message, 'custom error');
    t.is((err.cause as ApplicationFailure).type, 'CustomWorkflowError');
  });
});

// WorkerOptions path: parent class name matches subclass when using string-based
// names (lookup walks the prototype chain by `constructor.name`)
test('failureExceptionTypes - WorkerOptions parent class name matches subclass via prototype chain', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    workflowFailureErrorTypes: { '*': ['CustomWorkflowError'] },
  });
  await worker.runUntil(async () => {
    const err = (await t.throwsAsync(executeWorkflow(throwCustomSubError), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is(err.cause?.message, 'custom sub error');
  });
});

// WorkerOptions path: 'Error' base class matches any Error subclass
test('failureExceptionTypes - WorkerOptions Error base class matches any error', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    workflowFailureErrorTypes: { '*': ['Error'] },
  });
  await worker.runUntil(async () => {
    const err = (await t.throwsAsync(executeWorkflow(throwPlainError), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is(err.cause?.message, 'plain error');
  });
});

// WorkerOptions path: 'NondeterminismError' alias does NOT match an unrelated error
test('failureExceptionTypes - WorkerOptions NondeterminismError alias does not match unrelated error', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    workflowFailureErrorTypes: { '*': ['NondeterminismError'] },
  });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(throwCustomError);
    await assertWftFailureAndTerminate(handle, { messageContains: 'custom error' });
    t.pass();
  });
});

// WorkflowDefinitionOptions path: failureExceptionTypes causes execution failure
test('failureExceptionTypes - WorkflowDefinitionOptions causes WF execution failure', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const err = (await t.throwsAsync(executeWorkflow(throwCustomErrorWithDefinitionOptions), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is(err.cause?.message, 'custom error from definition options');
    t.is((err.cause as ApplicationFailure).type, 'CustomWorkflowError');
  });
});

// WorkflowDefinitionOptions path: instanceof check matches subclasses
test('failureExceptionTypes - WorkflowDefinitionOptions instanceof matches subclass', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const err = (await t.throwsAsync(executeWorkflow(throwSubErrorWithParentInDefinitionOptions), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is(err.cause?.message, 'sub error with parent in definition options');
    t.is((err.cause as ApplicationFailure).type, 'CustomWorkflowSubError');
  });
});

////////////////////////////////////////////////////////////////////////////////
// Non-determinism handling
////////////////////////////////////////////////////////////////////////////////

// Default behavior: a non-determinism error causes WFT failure (workflow keeps retrying)
test('non-determinism - default causes WFT failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ maxCachedWorkflows: 0 });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(nondeterministicWorkflow);
    await assertWftFailureAndTerminate(handle, { messageContains: 'Nondeterminism' });
    t.pass();
  });
});

// WorkerOptions path: 'NondeterminismError' alias causes the workflow execution
// to fail when a non-determinism error is detected.
test('non-determinism - WorkerOptions NondeterminismError causes WF execution failure', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    maxCachedWorkflows: 0,
    workflowFailureErrorTypes: { '*': ['NondeterminismError'] },
  });
  await worker.runUntil(async () => {
    const err = (await t.throwsAsync(executeWorkflow(nondeterministicWorkflow), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.regex(err.cause?.message ?? '', /[Nn]ondeterminism/);
  });
});
