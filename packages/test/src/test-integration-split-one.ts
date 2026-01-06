/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import asyncRetry from 'async-retry';
import { v4 as uuid4 } from 'uuid';
import dedent from 'dedent';
import * as iface from '@temporalio/proto';
import {
  ActivityFailure,
  ChildWorkflowFailure,
  QueryNotRegisteredError,
  WorkflowFailedError,
} from '@temporalio/client';
import type { SearchAttributes, WorkflowExecution } from '@temporalio/common';
import {
  ApplicationFailure,
  CancelledFailure,
  RetryState,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';
import { tsToMs } from '@temporalio/common/lib/time';
import pkg from '@temporalio/worker/lib/pkg';
import type { UnsafeWorkflowInfo, WorkflowInfo } from '@temporalio/workflow/lib/interfaces';

import {
  CancellationScope,
  defineQuery,
  executeChild,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import { configurableHelpers, createTestWorkflowBundle } from './helpers-integration';
import * as activities from './activities';
import { cleanOptionalStackTrace, compareStackTrace, u8, Worker } from './helpers';
import { configMacro, makeTestFn } from './helpers-integration-multi-codec';
import * as workflows from './workflows';

// Note: re-export shared workflows (or long workflows)
//  - review the files where these workflows are shared
export * from './workflows';

const { EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED } =
  iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);
const CHANGE_MARKER_NAME = 'core_patch';

const test = makeTestFn(() => createTestWorkflowBundle({ workflowsPath: __filename }));
test.macro(configMacro);

// FIXME: Unless we add .serial() here, ava tries to start all async tests in parallel, which
//        is ok in most environments, but has been causing flakyness in CI, especially on Windows.
//        We can probably avoid this by using larger runners, and there is some opportunity for
//        optimization here, but for now, let's just run these tests serially.
test.serial('Workflow not found results in task retry', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const handle = await client.workflow.start('not-found', {
    taskQueue,
    workflowId: uuid4(),
  });

  await worker.runUntil(async () => {
    await asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        if (
          !history?.events?.some(
            ({ workflowTaskFailedEventAttributes }) =>
              workflowTaskFailedEventAttributes?.failure?.message ===
              "Failed to initialize workflow of type 'not-found': no such function is exported by the workflow bundle"
          )
        ) {
          throw new Error('Cannot find workflow task failed event');
        }
      },
      {
        retries: 60,
        maxTimeout: 1000,
      }
    );
  });

  t.pass();
});

test.serial('args-and-return', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const res = await worker.runUntil(
    executeWorkflow(workflows.argsAndReturn, {
      args: ['Hello', undefined, u8('world!')],
    })
  );
  t.is(res, 'Hello, world!');
});

export async function urlEcho(url: string): Promise<string> {
  const parsedURL = new URL(url);
  const searchParams = new URLSearchParams({ counter: '1' });
  parsedURL.search = searchParams.toString();
  return parsedURL.toString();
}

test.serial('url-whatwg', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const res = await worker.runUntil(
    executeWorkflow(urlEcho, {
      args: ['http://foo.com'],
    })
  );
  t.is(res, 'http://foo.com/?counter=1');
});

test.serial('cancel-fake-progress', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);

  const worker = await createWorkerWithDefaults(t, {
    activities,
  });
  await worker.runUntil(executeWorkflow(workflows.cancelFakeProgress));
  t.pass();
});

export async function activityFailure(useApplicationFailure: boolean): Promise<void> {
  const { throwAnError } = proxyActivities({
    startToCloseTimeout: '5s',
    retry: { initialInterval: '1s', maximumAttempts: 1 },
  });
  if (useApplicationFailure) {
    await throwAnError(true, 'Fail me');
  } else {
    await throwAnError(false, 'Fail me');
  }
}

test.serial('activity-failure with Error', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(
      executeWorkflow(activityFailure, {
        args: [false],
      })
    ),
    {
      instanceOf: WorkflowFailedError,
    }
  );
  t.is(err?.message, 'Workflow execution failed');
  if (!(err?.cause instanceof ActivityFailure)) {
    t.fail('Expected err.cause to be an instance of ActivityFailure');
    return;
  }
  if (!(err.cause.cause instanceof ApplicationFailure)) {
    t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
    return;
  }
  t.is(err.cause.cause.message, 'Fail me');
  t.is(
    cleanOptionalStackTrace(err.cause.cause.stack),
    dedent`
  Error: Fail me
      at throwAnError (test/src/activities/index.ts)
  `
  );
});

test.serial('activity-failure with ApplicationFailure', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(
      executeWorkflow(activityFailure, {
        args: [true],
      })
    ),
    {
      instanceOf: WorkflowFailedError,
    }
  );
  t.is(err?.message, 'Workflow execution failed');
  if (!(err?.cause instanceof ActivityFailure)) {
    t.fail('Expected err.cause to be an instance of ActivityFailure');
    return;
  }
  if (!(err.cause.cause instanceof ApplicationFailure)) {
    t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
    return;
  }
  t.is(err.cause.cause.message, 'Fail me');
  t.is(err.cause.cause.type, 'Error');
  t.deepEqual(err.cause.cause.details, ['details', 123, false]);
  compareStackTrace(
    t,
    cleanOptionalStackTrace(err.cause.cause.stack)!,
    dedent`
  ApplicationFailure: Fail me
      at $CLASS.nonRetryable (common/src/failure.ts)
      at throwAnError (test/src/activities/index.ts)
    `
  );
});

export async function childWorkflowInvoke(): Promise<{
  workflowId: string;
  runId: string;
  execResult: string;
  result: string;
}> {
  const child = await startChild(workflows.successString, {});
  const execResult = await executeChild(workflows.successString, {});
  return { workflowId: child.workflowId, runId: child.firstExecutionRunId, result: await child.result(), execResult };
}

test.serial('child-workflow-invoke', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(childWorkflowInvoke);
  const { workflowId, runId, execResult, result } = await worker.runUntil(handle.result());
  t.is(execResult, 'success');
  t.is(result, 'success');
  const client = env.client;
  const child = client.workflow.getHandle(workflowId, runId);
  t.is(await child.result(), 'success');
});

export async function childWorkflowFailure(): Promise<void> {
  await executeChild(workflows.throwAsync);
}

test.serial('child-workflow-failure', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(executeWorkflow(childWorkflowFailure), {
      instanceOf: WorkflowFailedError,
    });

    if (!(err?.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    if (!(err.cause.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.cause.message, 'failure');
    compareStackTrace(
      t,
      cleanOptionalStackTrace(err.cause.cause.stack)!,
      dedent`
      ApplicationFailure: failure
          at $CLASS.nonRetryable (common/src/failure.ts)
          at throwAsync (test/src/workflows/throw-async.ts)
    `
    );
  });
});

const childExecutionQuery = defineQuery<WorkflowExecution | undefined>('childExecution');
export async function childWorkflowTermination(): Promise<void> {
  let workflowExecution: WorkflowExecution | undefined = undefined;
  setHandler(childExecutionQuery, () => workflowExecution);

  const child = await startChild(workflows.unblockOrCancel, {});
  workflowExecution = { workflowId: child.workflowId, runId: child.firstExecutionRunId };
  await child.result();
}

test.serial('child-workflow-termination', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(childWorkflowTermination);
  const client = env.client;

  let childExecution: WorkflowExecution | undefined = undefined;

  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      async () => {
        while (childExecution === undefined) {
          childExecution = await handle.query(childExecutionQuery);
        }
        const child = client.workflow.getHandle(childExecution.workflowId!, childExecution.runId!);
        await child.terminate();
        await handle.result();
      },
      {
        instanceOf: WorkflowFailedError,
      }
    );

    if (!(err?.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    t.is(err.cause.retryState, RetryState.NON_RETRYABLE_FAILURE);
    if (!(err.cause.cause instanceof TerminatedFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of TerminatedFailure');
    }
  });
});

export async function childWorkflowTimeout(): Promise<void> {
  await executeChild(workflows.unblockOrCancel, {
    workflowExecutionTimeout: '10ms',
    retry: { maximumAttempts: 1 },
  });
}

test.serial('child-workflow-timeout', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(executeWorkflow(childWorkflowTimeout)),
    {
      instanceOf: WorkflowFailedError,
    }
  );

  if (!(err?.cause instanceof ChildWorkflowFailure)) {
    return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
  }
  t.is(err.cause.retryState, RetryState.TIMEOUT);
  if (!(err.cause.cause instanceof TimeoutFailure)) {
    return t.fail('Expected err.cause.cause to be an instance of TimeoutFailure');
  }
  t.is(err.cause.cause.timeoutType, TimeoutType.START_TO_CLOSE);
});

export async function childWorkflowStartFail(): Promise<void> {
  const child = await startChild(workflows.successString, {
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });
  await child.result();

  try {
    await startChild(workflows.successString, {
      taskQueue: 'test',
      workflowId: child.workflowId, // duplicate
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    throw new Error('Managed to start a Workflow with duplicate workflowId');
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
      throw new Error(`Got invalid error: ${err}`);
    }
  }
}

test.serial('child-workflow-start-fail', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(childWorkflowStartFail));
  // Assertions in workflow code
  t.pass();
});

test.serial('child-workflow-cancel', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(workflows.childWorkflowCancel));
  // Assertions in workflow code
  t.pass();
});

test.serial('child-workflow-signals', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(workflows.childWorkflowSignals));
  // Assertions in workflow code
  t.pass();
});

test.serial('query not found', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.unblockOrCancel);
  await worker.runUntil(async () => {
    await handle.signal(workflows.unblockSignal);
    await handle.result();
    await t.throwsAsync(handle.query('not found'), {
      instanceOf: QueryNotRegisteredError,
      message:
        'Workflow did not register a handler for not found. Registered queries: [__stack_trace __enhanced_stack_trace __temporal_workflow_metadata isBlocked]',
    });
  });
});

test.serial('query and unblock', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.unblockOrCancel);
  await worker.runUntil(async () => {
    t.true(await handle.query(workflows.isBlockedQuery));
    await handle.signal(workflows.unblockSignal);
    await handle.result();
    t.false(await handle.query(workflows.isBlockedQuery));
  });
});

test.serial('interrupt-signal', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.interruptableWorkflow);
  await worker.runUntil(async () => {
    await handle.signal(workflows.interruptSignal, 'just because');
    const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'just because');
  });
});

test.serial('fail-signal', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.failSignalWorkflow);
  await worker.runUntil(async () => {
    await handle.signal(workflows.failSignal);
    const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });
});

test.serial('async-fail-signal', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.asyncFailSignalWorkflow);
  await handle.signal(workflows.failSignal);
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });
});

test.serial('http', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const res = await worker.runUntil(executeWorkflow(workflows.http));
  t.deepEqual(res, await activities.httpGet('https://temporal.io'));
});

test.serial('sleep', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.sleeper);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
  t.is(timerEvents.length, 2);
  t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
  t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
  t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '1');
});

test.serial('cancel-timer-immediately', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.cancelTimer);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
  // Timer is cancelled before it is scheduled
  t.is(timerEvents.length, 0);
});

export async function cancelTimerWithDelay(): Promise<void> {
  const scope = new CancellationScope();
  const promise = scope.run(() => sleep(10000));
  await sleep(1).then(() => scope.cancel());
  try {
    await promise;
  } catch (e) {
    if (e instanceof CancelledFailure) {
      console.log('Timer cancelled 👍');
    } else {
      throw e;
    }
  }
}

test.serial('cancel-timer-with-delay', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(cancelTimerWithDelay);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
  t.is(timerEvents.length, 4);
  t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
  t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 10000);
  t.is(timerEvents[1].timerStartedEventAttributes!.timerId, '2');
  t.is(tsToMs(timerEvents[1].timerStartedEventAttributes!.startToFireTimeout), 1);
  t.is(timerEvents[2].timerFiredEventAttributes!.timerId, '2');
  t.is(timerEvents[3].timerCanceledEventAttributes!.timerId, '1');
});

test.serial('patched', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.patchedWorkflow);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const hasChangeEvents = history.events!.filter(
    ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
  );
  // There will only be one marker despite there being 2 hasChange calls because they have the
  // same ID and core will only record one marker per id.
  t.is(hasChangeEvents.length, 1);
  t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
});

test.serial('deprecate-patch', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.deprecatePatchWorkflow);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const hasChangeEvents = history.events!.filter(
    ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
  );
  t.is(hasChangeEvents.length, 1);
  t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
});

test.serial('Worker default ServerOptions are generated correctly', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.argsAndReturn, {
    args: ['hey', undefined, Buffer.from('abc')],
  });
  await worker.runUntil(handle.result());
  const history = await handle.fetchHistory();
  const events = history.events!.filter(
    ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED
  );
  t.is(events.length, 1);
  const [event] = events;
  t.regex(event.workflowTaskCompletedEventAttributes!.identity!, /\d+@.+/);
  let binid = event.workflowTaskCompletedEventAttributes!.binaryChecksum!;
  if (binid === '') {
    binid = event.workflowTaskCompletedEventAttributes!.workerVersion!.buildId!;
  }
  t.regex(binid, /@temporalio\/worker@\d+\.\d+\.\d+/);
});

test.serial('WorkflowHandle.describe result is wrapped', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.argsAndReturn, {
    args: ['hey', undefined, Buffer.from('abc')],
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date],
    },
    memo: {
      note: 'foo',
    },
  });
  await worker.runUntil(handle.result());
  const execution = await handle.describe();
  t.deepEqual(execution.type, 'argsAndReturn');
  t.deepEqual(execution.memo, { note: 'foo' });
  t.true(execution.startTime instanceof Date);
  t.deepEqual(execution.searchAttributes!.CustomKeywordField, ['test-value']); // eslint-disable-line deprecation/deprecation
  t.deepEqual(execution.searchAttributes!.CustomIntField, [1]); // eslint-disable-line deprecation/deprecation
  t.deepEqual(execution.searchAttributes!.CustomDatetimeField, [date]); // eslint-disable-line deprecation/deprecation
  const binSum = execution.searchAttributes!.BinaryChecksums as string[]; // eslint-disable-line deprecation/deprecation
  if (binSum != null) {
    t.regex(binSum[0], /@temporalio\/worker@/);
  } else {
    t.deepEqual(execution.searchAttributes!.BuildIds, ['unversioned', `unversioned:${worker.options.buildId}`]); // eslint-disable-line deprecation/deprecation
  }
});

// eslint-disable-next-line deprecation/deprecation
export async function returnSearchAttributes(): Promise<SearchAttributes | undefined> {
  const sa = workflowInfo().searchAttributes!; // eslint-disable-line @typescript-eslint/no-non-null-assertion, deprecation/deprecation
  const datetime = (sa.CustomDatetimeField as Array<Date>)[0];
  return {
    ...sa,
    datetimeType: [Object.getPrototypeOf(datetime).constructor.name],
    datetimeInstanceofWorks: [datetime instanceof Date],
    arrayInstanceofWorks: [sa.CustomIntField instanceof Array],
  };
}

test.serial('Workflow can read Search Attributes set at start', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(returnSearchAttributes, {
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date],
    },
  });
  const res = await worker.runUntil(handle.result());
  t.deepEqual(res, {
    CustomKeywordField: ['test-value'],
    CustomIntField: [1],
    CustomDatetimeField: [date.toISOString()],
    datetimeInstanceofWorks: [true],
    arrayInstanceofWorks: [true],
    datetimeType: ['Date'],
  });
});

test.serial('Workflow can upsert Search Attributes', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.upsertAndReadSearchAttributes, {
    args: [date.getTime()],
  });
  const res = await worker.runUntil(handle.result());
  t.deepEqual(res, {
    CustomBoolField: [true],
    CustomKeywordField: ['durable code'],
    CustomTextField: ['is useful'],
    CustomDatetimeField: [date.toISOString()],
    CustomDoubleField: [3.14],
  });
  const { searchAttributes } = await handle.describe(); // eslint-disable-line deprecation/deprecation
  const { BinaryChecksums, BuildIds, ...rest } = searchAttributes;
  t.deepEqual(rest, {
    CustomBoolField: [true],
    CustomKeywordField: ['durable code'],
    CustomTextField: ['is useful'],
    CustomDatetimeField: [date],
    CustomDoubleField: [3.14],
  });
  let checksum: any;
  if (BinaryChecksums != null) {
    t.true(BinaryChecksums.length === 1);
    checksum = BinaryChecksums[0];
  } else {
    t.true(BuildIds!.length === 2);
    t.deepEqual(BuildIds![0], 'unversioned');
    checksum = BuildIds![1];
  }
  t.true(
    typeof checksum === 'string' &&
      checksum.includes(`@temporalio/worker@${pkg.version}+`) &&
      /\+[a-f0-9]{64}$/.test(checksum) // bundle checksum
  );
});

export async function returnWorkflowInfo(): Promise<WorkflowInfo> {
  return workflowInfo();
}

test.serial('Workflow can read WorkflowInfo', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow, taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(returnWorkflowInfo, {
    memo: {
      nested: { object: true },
    },
  });
  const res = await worker.runUntil(handle.result());
  t.assert(res.historySize > 100);
  t.deepEqual(res, {
    memo: {
      nested: { object: true },
    },
    attempt: 1,
    firstExecutionRunId: handle.firstExecutionRunId,
    namespace: 'default',
    taskTimeoutMs: 10_000,
    runId: handle.firstExecutionRunId,
    taskQueue,
    searchAttributes: {},
    // Typed search attributes gets serialized as an array.
    typedSearchAttributes: [],
    workflowType: 'returnWorkflowInfo',
    workflowId: handle.workflowId,
    historyLength: 3,
    continueAsNewSuggested: false,
    // values ignored for the purpose of comparison
    historySize: res.historySize,
    startTime: res.startTime,
    runStartTime: res.runStartTime,
    currentBuildId: res.currentBuildId, // eslint-disable-line deprecation/deprecation
    currentDeploymentVersion: res.currentDeploymentVersion,
    // unsafe.now is a function, so doesn't make it through serialization, but .now is required, so we need to cast
    unsafe: { isReplaying: false } as UnsafeWorkflowInfo,
    priority: {},
  });
});

/**
 * NOTE: this test uses the `IN` operator API which requires advanced visibility as of server 1.18.
 * It will silently succeed on servers that only support standard visibility (can't dynamically skip a test).
 */
test.serial('Download and replay multiple executions with client list method', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;

  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const client = env.client;
  try {
    const fns = [workflows.http, workflows.cancelFakeProgress, childWorkflowInvoke, workflows.activityFailures];
    const handles = await Promise.all(fns.map((fn) => startWorkflow(fn)));
    // Wait for the workflows to complete first
    await worker.runUntil(Promise.all(handles.map((h) => h.result())));
    // Test the list API too while we're at it
    const workflowIds = handles.map(({ workflowId }) => `'${workflowId}'`);
    const histories = client.workflow.list({ query: `WorkflowId IN (${workflowIds.join(', ')})` }).intoHistories();
    const results = Worker.runReplayHistories(
      {
        workflowBundle: worker.options.workflowBundle,
        dataConverter: env.options.client.dataConverter,
      },
      histories
    );

    for await (const result of results) {
      t.is(result.error, undefined);
    }
  } catch (e) {
    // Don't report a test failure if the server does not support extended query
    if (!(e as Error).message?.includes(`operator 'in' not allowed`)) throw e;
  }
  t.pass();
});
