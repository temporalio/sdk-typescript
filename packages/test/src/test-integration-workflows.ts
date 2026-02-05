import { setTimeout as setTimeoutPromise } from 'timers/promises';
import { randomUUID } from 'crypto';
import asyncRetry from 'async-retry';
import { ExecutionContext } from 'ava';
import { firstValueFrom, Subject } from 'rxjs';
import { Client, WorkflowClient, WorkflowFailedError, WorkflowHandle } from '@temporalio/client';
import * as activity from '@temporalio/activity';
import { msToNumber, tsToMs } from '@temporalio/common/lib/time';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { CancelReason } from '@temporalio/worker/lib/activity';
import * as workflow from '@temporalio/workflow';
import {
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  setDefaultQueryHandler,
  setDefaultSignalHandler,
  setDefaultUpdateHandler,
  setHandler,
} from '@temporalio/workflow';
import { SdkFlags } from '@temporalio/workflow/lib/flags';
import {
  ActivityCancellationDetails,
  ActivityCancellationType,
  ApplicationFailure,
  defineSearchAttributeKey,
  encodingKeys,
  METADATA_ENCODING_KEY,
  RawValue,
  SearchAttributePair,
  SearchAttributeType,
  SuggestContinueAsNewReason,
  TypedSearchAttributes,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';
import {
  TEMPORAL_RESERVED_PREFIX,
  STACK_TRACE_QUERY_NAME,
  ENHANCED_STACK_TRACE_QUERY_NAME,
} from '@temporalio/common/lib/reserved';
import { encode } from '@temporalio/common/lib/encoding';
import { signalSchedulingWorkflow } from './activities/helpers';
import { activityStartedSignal } from './workflows/definitions';
import * as workflows from './workflows';
import { Context, createLocalTestEnvironment, helpers, makeTestFunction } from './helpers-integration';
import { overrideSdkInternalFlag } from './mock-internal-flags';
import { ActivityState, heartbeatCancellationDetailsActivity } from './activities/heartbeat-cancellation-details';
import { loadHistory, RUN_TIME_SKIPPING_TESTS, waitUntil } from './helpers';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

export async function parent(): Promise<void> {
  await workflow.startChild(child, { workflowId: 'child' });
  await workflow.startChild(child, { workflowId: 'child' });
}

export async function child(): Promise<void> {
  await workflow.CancellationScope.current().cancelRequested;
}

test('Workflow fails if it tries to start a child with an existing workflow ID', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const err = await t.throwsAsync(executeWorkflow(parent), {
      instanceOf: WorkflowFailedError,
    });
    t.true(
      err instanceof WorkflowFailedError &&
        err.cause?.name === 'TemporalFailure' &&
        err.cause?.message === 'Workflow execution already started'
    );
  });
});

export async function runTestActivity(activityOptions?: workflow.ActivityOptions): Promise<void> {
  await workflow.proxyActivities({ startToCloseTimeout: '1m', ...activityOptions }).testActivity();
}

test('Worker cancels activities after shutdown has been requested', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  let cancelReason = null as CancelReason | null;
  const worker = await createWorker({
    activities: {
      async testActivity() {
        const ctx = activity.Context.current();
        worker.shutdown();
        try {
          await ctx.cancelled;
        } catch (err) {
          if (err instanceof activity.CancelledFailure) {
            cancelReason = err.message as CancelReason;
          }
          throw err;
        }
      },
    },
  });
  await startWorkflow(runTestActivity);
  // If worker completes within graceful shutdown period, the activity has successfully been cancelled
  await worker.run();
  t.is(cancelReason, 'WORKER_SHUTDOWN');
});

export async function cancelFakeProgress(): Promise<void> {
  const { fakeProgress, shutdownWorker } = workflow.proxyActivities({
    startToCloseTimeout: '200s',
    cancellationType: workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  });

  await workflow.CancellationScope.cancellable(async () => {
    const promise = fakeProgress();
    await new Promise<void>((resolve) => workflow.setHandler(activityStartedSignal, resolve));
    workflow.CancellationScope.current().cancel();
    await workflow.CancellationScope.nonCancellable(shutdownWorker);
    await promise;
  });
}

test('Worker allows heartbeating activities after shutdown has been requested', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const workerWasShutdownSubject = new Subject<void>();
  let cancelReason = null as CancelReason | null;

  const worker = await createWorker({
    shutdownGraceTime: '5m',
    activities: {
      async fakeProgress() {
        await signalSchedulingWorkflow(activityStartedSignal.name);
        const ctx = activity.Context.current();
        await firstValueFrom(workerWasShutdownSubject);
        try {
          for (;;) {
            await ctx.sleep('100ms');
            ctx.heartbeat();
          }
        } catch (err) {
          if (err instanceof activity.CancelledFailure) {
            cancelReason = err.message as CancelReason;
          }
          throw err;
        }
      },
      async shutdownWorker() {
        worker.shutdown();
        workerWasShutdownSubject.next();
      },
    },
  });
  await startWorkflow(cancelFakeProgress);
  await worker.run();
  t.is(cancelReason, 'CANCELLED');
});

export async function conditionTimeout0(): Promise<boolean | undefined> {
  return await workflow.condition(() => false, 0);
}

test('Condition 0 patch sets a timer', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  t.false(await worker.runUntil(executeWorkflow(conditionTimeout0)));
});

export async function historySizeGrows(): Promise<[number, number]> {
  const before = workflow.workflowInfo().historySize;
  await workflow.sleep(1);
  const after = workflow.workflowInfo().historySize;
  return [before, after];
}

test('HistorySize grows with new WFT', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const [before, after] = await worker.runUntil(executeWorkflow(historySizeGrows));
  t.true(after > before && before > 100);
});

test('HistorySize is visible in WorkflowExecutionInfo', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const handle = await startWorkflow(historySizeGrows);

  await worker.runUntil(handle.result());
  const historySize = (await handle.describe()).historySize;
  t.true(historySize && historySize > 100);
});

export async function suggestedCAN(): Promise<boolean> {
  const maxEvents = 40_000;
  const batchSize = 1000;
  if (workflow.workflowInfo().continueAsNewSuggested) {
    return false;
  }
  while (workflow.workflowInfo().historyLength < maxEvents) {
    await Promise.all(Array.from({ length: batchSize }, (_) => workflow.sleep(1)));
    if (workflow.workflowInfo().continueAsNewSuggested) {
      return true;
    }
  }
  return false;
}

test('ContinueAsNew is suggested', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const flaggedCAN = await worker.runUntil(executeWorkflow(suggestedCAN));
  t.true(flaggedCAN);
});

test('Activity initialInterval is not getting rounded', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      testActivity: () => undefined,
    },
  });
  const handle = await startWorkflow(runTestActivity, {
    args: [
      {
        startToCloseTimeout: '5s',
        retry: { initialInterval: '50ms', maximumAttempts: 1 },
      },
    ],
  });
  await worker.runUntil(handle.result());
  const { events } = await handle.fetchHistory();
  const activityTaskScheduledEvents = events?.find((ev) => ev.activityTaskScheduledEventAttributes);
  const retryPolicy = activityTaskScheduledEvents?.activityTaskScheduledEventAttributes?.retryPolicy;
  t.is(tsToMs(retryPolicy?.initialInterval), 50);
});

test('Start of workflow is delayed', async (t) => {
  const { startWorkflow } = helpers(t);
  // This workflow never runs
  const handle = await startWorkflow(runTestActivity, {
    startDelay: '5678s',
  });
  const { events } = await handle.fetchHistory();
  const workflowExecutionStartedEvent = events?.find((ev) => ev.workflowExecutionStartedEventAttributes);
  const startDelay = workflowExecutionStartedEvent?.workflowExecutionStartedEventAttributes?.firstWorkflowTaskBackoff;
  t.is(tsToMs(startDelay), 5678000);
});

export async function conflictId(): Promise<void> {
  await workflow.condition(() => false);
}

test('Start of workflow respects workflow id conflict policy', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;

  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(conflictId, {
      taskQueue,
      workflowId: wfid,
    });
    const handleWithRunId = client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);

    // Confirm another fails by default
    const err = await t.throwsAsync(
      client.workflow.start(conflictId, {
        taskQueue,
        workflowId: wfid,
      }),
      {
        instanceOf: WorkflowExecutionAlreadyStartedError,
      }
    );

    t.true(err instanceof WorkflowExecutionAlreadyStartedError);

    // Confirm fails with explicit option
    const err1 = await t.throwsAsync(
      client.workflow.start(conflictId, {
        taskQueue,
        workflowId: wfid,
        workflowIdConflictPolicy: 'FAIL',
      }),
      {
        instanceOf: WorkflowExecutionAlreadyStartedError,
      }
    );

    t.true(err1 instanceof WorkflowExecutionAlreadyStartedError);

    // Confirm gives back same handle
    const handle2 = await client.workflow.start(conflictId, {
      taskQueue,
      workflowId: wfid,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });

    const desc = await handleWithRunId.describe();
    const desc2 = await handle2.describe();

    t.is(desc.runId, desc2.runId);
    t.is(desc.status.name, 'RUNNING');
    t.is(desc2.status.name, 'RUNNING');

    // Confirm terminates and starts new
    const handle3 = await client.workflow.start(conflictId, {
      taskQueue,
      workflowId: wfid,
      workflowIdConflictPolicy: 'TERMINATE_EXISTING',
    });

    const descWithRunId = await handleWithRunId.describe();
    const desc3 = await handle3.describe();
    t.not(descWithRunId.runId, desc3.runId);
    t.is(descWithRunId.status.name, 'TERMINATED');
    t.is(desc3.status.name, 'RUNNING');
  });
});

// FIXME: This test is passing, but spitting out "signalTarget not exported by
//        the workflow bundle" errors. To be revisited at a later time.
test('Start of workflow with signal respects conflict id policy', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(workflows.signalTarget, {
      taskQueue,
      workflowId: wfid,
    });
    const handleWithRunId = client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);

    // Confirm gives back same handle is the default policy
    const handle2 = await t.context.env.client.workflow.signalWithStart(workflows.signalTarget, {
      taskQueue,
      workflowId: wfid,
      signal: workflows.argsTestSignal,
      signalArgs: [123, 'kid'],
    });
    const desc = await handleWithRunId.describe();
    const desc2 = await handle2.describe();

    t.deepEqual(desc.runId, desc2.runId);
    t.deepEqual(desc.status.name, 'RUNNING');
    t.deepEqual(desc2.status.name, 'RUNNING');

    // Confirm terminates and starts new
    const handle3 = await t.context.env.client.workflow.signalWithStart(workflows.signalTarget, {
      taskQueue,
      workflowId: wfid,
      signal: workflows.argsTestSignal,
      signalArgs: [123, 'kid'],
      workflowIdConflictPolicy: 'TERMINATE_EXISTING',
    });

    const descWithRunId = await handleWithRunId.describe();
    const desc3 = await handle3.describe();
    t.true(descWithRunId.runId !== desc3.runId);
    t.deepEqual(descWithRunId.status.name, 'TERMINATED');
    t.deepEqual(desc3.status.name, 'RUNNING');
  });
});

test('Start of workflow with signal is delayed', async (t) => {
  const { taskQueue } = helpers(t);
  // This workflow never runs
  const handle = await t.context.env.client.workflow.signalWithStart(workflows.interruptableWorkflow, {
    workflowId: randomUUID(),
    taskQueue,
    startDelay: '4678s',
    signal: workflows.interruptSignal,
    signalArgs: ['Never called'],
  });

  const { events } = await handle.fetchHistory();
  const workflowExecutionStartedEvent = events?.find((ev) => ev.workflowExecutionStartedEventAttributes);
  const startDelay = workflowExecutionStartedEvent?.workflowExecutionStartedEventAttributes?.firstWorkflowTaskBackoff;
  t.is(tsToMs(startDelay), 4678000);
});

export async function queryWorkflowMetadata(): Promise<void> {
  const dummyQuery1 = workflow.defineQuery<void>('dummyQuery1');
  const dummyQuery2 = workflow.defineQuery<void>('dummyQuery2');
  const dummyQuery3 = workflow.defineQuery<void>('dummyQuery3');
  const dummySignal1 = workflow.defineSignal('dummySignal1');
  const dummyUpdate1 = workflow.defineUpdate<void>('dummyUpdate1');

  workflow.setHandler(dummyQuery1, () => void {}, { description: 'ignore' });
  // Override description
  workflow.setHandler(dummyQuery1, () => void {}, { description: 'query1' });
  workflow.setHandler(dummyQuery2, () => void {}, { description: 'query2' });
  workflow.setHandler(dummyQuery3, () => void {}, { description: 'query3' });
  // Remove handler
  workflow.setHandler(dummyQuery3, undefined);
  workflow.setHandler(dummySignal1, () => void {}, { description: 'signal1' });
  workflow.setHandler(dummyUpdate1, () => void {}, { description: 'update1' });
  await workflow.condition(() => false);
}

test('Query workflow metadata returns handler descriptions', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker();

  await worker.runUntil(async () => {
    const handle = await startWorkflow(queryWorkflowMetadata);
    const meta = await handle.query(workflow.workflowMetadataQuery);
    t.is(meta.definition?.type, 'queryWorkflowMetadata');
    const queryDefinitions = meta.definition?.queryDefinitions;
    // Three built-in ones plus dummyQuery1 and dummyQuery2
    t.is(queryDefinitions?.length, 5);
    t.deepEqual(queryDefinitions?.[3], { name: 'dummyQuery1', description: 'query1' });
    t.deepEqual(queryDefinitions?.[4], { name: 'dummyQuery2', description: 'query2' });
    const signalDefinitions = meta.definition?.signalDefinitions;
    t.deepEqual(signalDefinitions, [{ name: 'dummySignal1', description: 'signal1' }]);
    const updateDefinitions = meta.definition?.updateDefinitions;
    t.deepEqual(updateDefinitions, [{ name: 'dummyUpdate1', description: 'update1' }]);
  });
});

export async function executeEagerActivity(): Promise<void> {
  const scheduleActivity = () =>
    workflow
      .proxyActivities({
        scheduleToCloseTimeout: '5s',
        allowEagerDispatch: true,
      })
      .testActivity()
      .then((res) => {
        if (res !== 'workflow-and-activity-worker')
          throw workflow.ApplicationFailure.nonRetryable('Activity was not eagerly dispatched');
      });

  for (let i = 0; i < 10; i++) {
    // Schedule 3 activities at a time (`MAX_EAGER_ACTIVITY_RESERVATIONS_PER_WORKFLOW_TASK`)
    await Promise.all([scheduleActivity(), scheduleActivity(), scheduleActivity()]);
  }
}

test('Worker requests Eager Activity Dispatch if possible', async (t) => {
  const { createWorker, startWorkflow, createNativeConnection } = helpers(t);

  // If eager activity dispatch is working, then the task will always be dispatched to the workflow
  // worker. Otherwise, chances are 50%-50% for either workers. The test workflow schedule the
  // activity 30 times to make sure that the workflow worker is really getting the task thanks to
  // eager activity dispatch, and not out of pure luck.

  const activityWorker = await createWorker({
    activities: {
      testActivity: () => 'activity-only-worker',
    },
    // Override the default workflow bundle, to make this an activity-only worker
    workflowBundle: undefined,
  });
  const workflowWorkerConnection = await createNativeConnection();
  t.teardown(() => workflowWorkerConnection.close());
  const workflowWorker = await createWorker({
    connection: workflowWorkerConnection,
    activities: {
      testActivity: () => 'workflow-and-activity-worker',
    },
  });
  const handle = await startWorkflow(executeEagerActivity);
  await activityWorker.runUntil(workflowWorker.runUntil(handle.result()));
  const { events } = await handle.fetchHistory();

  t.false(events?.some?.((ev) => ev.activityTaskTimedOutEventAttributes));
  const activityTaskStarted = events?.filter?.((ev) => ev.activityTaskStartedEventAttributes);
  t.is(activityTaskStarted?.length, 30);
  t.true(activityTaskStarted?.every((ev) => ev.activityTaskStartedEventAttributes?.attempt === 1));
});

export async function dontExecuteEagerActivity(): Promise<string> {
  return (await workflow
    .proxyActivities({ scheduleToCloseTimeout: '5s', allowEagerDispatch: true })
    .testActivity()
    .catch(() => 'failed')) as string;
}

test("Worker doesn't request Eager Activity Dispatch if no activities are registered", async (t) => {
  const { createNativeConnection, createWorker, startWorkflow } = helpers(t);

  // If the activity was eagerly dispatched to the Workflow worker even though it is a Workflow-only
  // worker, then the activity execution will timeout (because tasks are not being polled) or
  // otherwise fail (because no activity is registered under that name). Therefore, if the history
  // shows only one attempt for that activity and no timeout, that can only mean that the activity
  // was not eagerly dispatched.

  const activityWorker = await createWorker({
    activities: {
      testActivity: () => 'success',
    },
    // Override the default workflow bundle, to make this an activity-only worker
    workflowBundle: undefined,
  });
  const workflowWorkerConnection = await createNativeConnection();
  t.teardown(() => workflowWorkerConnection.close());
  const workflowWorker = await createWorker({
    connection: workflowWorkerConnection,
    activities: {},
  });
  const handle = await startWorkflow(dontExecuteEagerActivity);
  const result = await activityWorker.runUntil(workflowWorker.runUntil(handle.result()));
  const { events } = await handle.fetchHistory();

  t.is(result, 'success');
  t.false(events?.some?.((ev) => ev.activityTaskTimedOutEventAttributes));
  const activityTaskStarted = events?.filter?.((ev) => ev.activityTaskStartedEventAttributes);
  t.is(activityTaskStarted?.length, 1);
  t.is(activityTaskStarted?.[0]?.activityTaskStartedEventAttributes?.attempt, 1);
});

const unblockSignal = defineSignal('unblock');
const getBuildIdQuery = defineQuery<string>('getBuildId');

export async function buildIdTester(): Promise<void> {
  let blocked = true;
  workflow.setHandler(unblockSignal, () => {
    blocked = false;
  });

  workflow.setHandler(getBuildIdQuery, () => {
    return workflow.workflowInfo().currentBuildId ?? ''; // eslint-disable-line deprecation/deprecation
  });

  // The unblock signal will only be sent once we are in Worker 1.1.
  // Therefore, up to this point, we are runing in Worker 1.0
  await workflow.condition(() => !blocked);
  // From this point on, we are runing in Worker 1.1

  // Prevent workflow completion
  await workflow.condition(() => false);
}

test('Build Id appropriately set in workflow info', async (t) => {
  const { taskQueue, createWorker } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;

  const worker1 = await createWorker({ buildId: '1.0' });
  await worker1.runUntil(async () => {
    const handle = await client.workflow.start(buildIdTester, {
      taskQueue,
      workflowId: wfid,
    });
    t.is(await handle.query(getBuildIdQuery), '1.0');
  });

  await client.workflowService.resetStickyTaskQueue({
    namespace: worker1.options.namespace,
    execution: { workflowId: wfid },
  });

  const worker2 = await createWorker({ buildId: '1.1' });
  await worker2.runUntil(async () => {
    const handle = await client.workflow.getHandle(wfid);
    t.is(await handle.query(getBuildIdQuery), '1.0');
    await handle.signal(unblockSignal);
    t.is(await handle.query(getBuildIdQuery), '1.1');
  });
});

export async function runDelayedRetryActivities(): Promise<void> {
  const startTime = Date.now();
  const localActs = workflow.proxyLocalActivities({
    startToCloseTimeout: '20s',
    retry: { initialInterval: '1ms', maximumInterval: '1ms', maximumAttempts: 2 },
  });
  const normalActs = workflow.proxyActivities({
    startToCloseTimeout: '20s',
    retry: { initialInterval: '1ms', maximumInterval: '1ms', maximumAttempts: 2 },
  });
  await Promise.all([localActs.testActivity(), normalActs.testActivity()]);
  const endTime = Date.now();
  if (endTime - startTime < 2000) {
    throw ApplicationFailure.nonRetryable('Expected workflow to take at least 2 seconds to complete');
  }
}

test('nextRetryDelay for activities', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      async testActivity() {
        // Need to fail on first try
        if (activity.activityInfo().attempt === 1) {
          throw ApplicationFailure.create({ message: 'ahh', nextRetryDelay: '2s' });
        }
      },
    },
  });
  const handle = await startWorkflow(runDelayedRetryActivities);
  await worker.runUntil(handle.result());
  t.pass();
});

// Repro for https://github.com/temporalio/sdk-typescript/issues/1423
export async function issue1423Workflow(legacyCompatibility: boolean): Promise<'threw' | 'didnt-throw'> {
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, !legacyCompatibility);
  try {
    workflow.CancellationScope.current().cancel();
    // We expect this to throw a CancellationException
    await workflow.sleep(1);
    throw workflow.ApplicationFailure.nonRetryable("sleep in cancelled scope didn't throw");
  } catch (_err) {
    return await workflow.CancellationScope.nonCancellable(async () => {
      try {
        await workflow.condition(() => false, 1);
        return 'didnt-throw'; // that's the correct behavior
      } catch (error) {
        if (workflow.isCancellation(error)) {
          return 'threw'; // that's what would happen until 1.10.2
        }
        throw error; // Shouldn't happen
      }
    });
  }
}

// Validate that issue #1423 is fixed in 1.10.3+
test('issue-1423 - 1.10.3+', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({});
  const conditionResult = await worker.runUntil(async () => {
    return await executeWorkflow(issue1423Workflow, { args: [false] });
  });
  t.is('didnt-throw', conditionResult);
});

// Validate that issue #1423 behavior is maintained in 1.10.2 in replay mode
test('issue-1423 - legacy', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const conditionResult = await worker.runUntil(async () => {
    return await executeWorkflow(issue1423Workflow, { args: [true] });
  });
  t.is('threw', conditionResult);
});

export async function nonCancellableScopesBeforeAndAfterWorkflow(): Promise<[boolean, boolean]> {
  // Start in legacy mode, similar to replaying an execution from a pre-1.10.3 workflow
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, false);

  const parentScope1 = new workflow.CancellationScope({ cancellable: false });
  const childScope1 = new workflow.CancellationScope({ cancellable: true, parent: parentScope1 });
  const parentScope2 = new workflow.CancellationScope({ cancellable: false });
  const childScope2 = new workflow.CancellationScope({ cancellable: true, parent: parentScope2 });

  parentScope1.cancel();
  await Promise.resolve();
  const childScope1Cancelled = childScope1.consideredCancelled;

  // Now enable the fix
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, true);
  parentScope2.cancel();
  await Promise.resolve();
  const childScope2Cancelled = childScope2.consideredCancelled;

  return [childScope1Cancelled, childScope2Cancelled];
}

test('Propagation of cancellation from non-cancellable scopes - before vs after', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const [childScope1Cancelled, childScope2Cancelled] = await worker.runUntil(
    executeWorkflow(nonCancellableScopesBeforeAndAfterWorkflow)
  );
  t.true(childScope1Cancelled);
  t.false(childScope2Cancelled);
});

// The following workflow is used to extensively test CancellationScopes cancellation propagation in various scenarios
export async function cancellableScopesExtensiveChecksWorkflow(
  parentCancellable: boolean,
  childCancellable: boolean,
  legacyCompatibility: boolean
): Promise<CancellableScopesExtensiveChecks> {
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, !legacyCompatibility);

  function expectCancellation(p: Promise<unknown>): () => boolean {
    let cancelled = false;
    let exception: Error | undefined = undefined;
    p.catch((e) => {
      if (workflow.isCancellation(e)) {
        cancelled = true;
      } else {
        exception = e;
      }
    });
    return () => {
      if (exception) throw exception;
      return cancelled;
    };
  }

  // A non-existant child workflow that we'll use to send (and cancel) signals
  const signalTargetWorkflow = await workflow.startChild('not-existant', {
    taskQueue: 'not-existant',
    workflowRunTimeout: '60s',
  });

  const { someActivity } = workflow.proxyActivities({
    scheduleToCloseTimeout: 5000,
    taskQueue: 'non-existant',
  });
  const { sleepLA } = workflow.proxyLocalActivities({ scheduleToCloseTimeout: 5000 });

  const checks: { [k in keyof CancellableScopesExtensiveChecks]?: ReturnType<typeof expectCancellation> } = {};

  // This will not block/throw, as the run function itself doesn't actually await on promises created inside
  const parentScope = new workflow.CancellationScope({ cancellable: parentCancellable });
  await parentScope.run(async () => {
    checks.parentScope_timerCancelled = expectCancellation(workflow.sleep(2000));
    checks.parentScope_activityCancelled = expectCancellation(someActivity());
    checks.parentScope_localActivityCancelled = expectCancellation(sleepLA(2000));
    checks.parentScope_signalExtWorkflowCancelled = expectCancellation(signalTargetWorkflow.signal('signal'));
  });
  checks.parentScope_cancelRequestedCancelled = expectCancellation(parentScope.cancelRequested);

  // This will not block/throw, as the run function itself doesn't actually await on promises created inside
  const childScope = new workflow.CancellationScope({
    cancellable: childCancellable,
    parent: parentScope,
  });
  await childScope.run(async () => {
    checks.childScope_timerCancelled = expectCancellation(workflow.sleep(2000));
    checks.childScope_activityCancelled = expectCancellation(someActivity());
    checks.childScope_localActivityCancelled = expectCancellation(sleepLA(2000));
    checks.childScope_signalExtWorkflowCancelled = expectCancellation(signalTargetWorkflow.signal('signal'));
  });
  checks.childScope_cancelRequestedCancelled = expectCancellation(childScope.cancelRequested);

  parentScope.cancel();

  // Flush all commands to Core, so that cancellations get a chance to be processed
  await sleepLA(1);

  return {
    ...Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v()] as const)),
    parentScope_consideredCancelled: parentScope.consideredCancelled,
    childScope_consideredCancelled: childScope.consideredCancelled,
  } as unknown as CancellableScopesExtensiveChecks;
}

interface CancellableScopesExtensiveChecks {
  parentScope_cancelRequestedCancelled: boolean;
  parentScope_timerCancelled: boolean;
  parentScope_activityCancelled: boolean;
  parentScope_localActivityCancelled: boolean;
  parentScope_signalExtWorkflowCancelled: boolean;
  parentScope_consideredCancelled: boolean;

  childScope_cancelRequestedCancelled: boolean;
  childScope_timerCancelled: boolean;
  childScope_activityCancelled: boolean;
  childScope_localActivityCancelled: boolean;
  childScope_signalExtWorkflowCancelled: boolean;
  childScope_consideredCancelled: boolean;
}

async function cancellableScopesExtensiveChecksHelper(
  t: ExecutionContext<Context>,
  parentCancellable: boolean,
  childCancellable: boolean,
  legacyCompatibility: boolean,
  expected: CancellableScopesExtensiveChecks
) {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      sleepLA: activity.sleep,
    },
  });

  await worker.runUntil(async () => {
    // cancellable/cancellable
    t.deepEqual(
      await executeWorkflow(cancellableScopesExtensiveChecksWorkflow, {
        args: [parentCancellable, childCancellable, legacyCompatibility],
      }),
      expected
    );
  });
}

test('CancellableScopes extensive checks - cancelleable/cancellable - 1.10.3+', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, true, true, false, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: true,
    parentScope_activityCancelled: true,
    parentScope_localActivityCancelled: true,
    parentScope_signalExtWorkflowCancelled: true,
    parentScope_consideredCancelled: true,

    childScope_cancelRequestedCancelled: true,
    childScope_timerCancelled: true,
    childScope_activityCancelled: true,
    childScope_localActivityCancelled: true,
    childScope_signalExtWorkflowCancelled: true,
    childScope_consideredCancelled: true,
  });
});

test('CancellableScopes extensive checks - cancelleable/cancellable - legacy', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, true, true, true, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: true,
    parentScope_activityCancelled: true,
    parentScope_localActivityCancelled: true,
    parentScope_signalExtWorkflowCancelled: true,
    parentScope_consideredCancelled: true,

    childScope_cancelRequestedCancelled: true,
    childScope_timerCancelled: true,
    childScope_activityCancelled: true,
    childScope_localActivityCancelled: true,
    childScope_signalExtWorkflowCancelled: true,
    childScope_consideredCancelled: true,
  });
});

test('CancellableScopes extensive checks - cancelleable/non-cancellable - 1.10.3+', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, true, false, false, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: true,
    parentScope_activityCancelled: true,
    parentScope_localActivityCancelled: true,
    parentScope_signalExtWorkflowCancelled: true,
    parentScope_consideredCancelled: true,

    childScope_cancelRequestedCancelled: true,
    childScope_timerCancelled: false,
    childScope_activityCancelled: false,
    childScope_localActivityCancelled: false,
    childScope_signalExtWorkflowCancelled: false,
    childScope_consideredCancelled: false,
  });
});

test('CancellableScopes extensive checks - cancelleable/non-cancellable - legacy', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, true, false, true, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: true,
    parentScope_activityCancelled: true,
    parentScope_localActivityCancelled: true,
    parentScope_signalExtWorkflowCancelled: true,
    parentScope_consideredCancelled: true,

    childScope_cancelRequestedCancelled: true,
    childScope_timerCancelled: false,
    childScope_activityCancelled: false,
    childScope_localActivityCancelled: false,
    childScope_signalExtWorkflowCancelled: false,
    childScope_consideredCancelled: false,
  });
});

test('CancellableScopes extensive checks - non-cancelleable/cancellable - 1.10.3+', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, false, true, false, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: false,
    parentScope_activityCancelled: false,
    parentScope_localActivityCancelled: false,
    parentScope_signalExtWorkflowCancelled: false,
    parentScope_consideredCancelled: false,

    childScope_cancelRequestedCancelled: false,
    childScope_timerCancelled: false,
    childScope_activityCancelled: false,
    childScope_localActivityCancelled: false,
    childScope_signalExtWorkflowCancelled: false,
    childScope_consideredCancelled: false,
  });
});

test('CancellableScopes extensive checks - non-cancelleable/cancellable - legacy', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, false, true, true, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: false,
    parentScope_activityCancelled: false,
    parentScope_localActivityCancelled: false,
    parentScope_signalExtWorkflowCancelled: false,
    parentScope_consideredCancelled: false,

    childScope_cancelRequestedCancelled: true, // These were incorrect before 1.10.3
    childScope_timerCancelled: true,
    childScope_activityCancelled: true,
    childScope_localActivityCancelled: true,
    childScope_signalExtWorkflowCancelled: true,
    childScope_consideredCancelled: true,
  });
});

test('CancellableScopes extensive checks - non-cancelleable/non-cancellable - 1.10.3+', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, false, false, false, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: false,
    parentScope_activityCancelled: false,
    parentScope_localActivityCancelled: false,
    parentScope_signalExtWorkflowCancelled: false,
    parentScope_consideredCancelled: false,

    childScope_cancelRequestedCancelled: false,
    childScope_timerCancelled: false,
    childScope_activityCancelled: false,
    childScope_localActivityCancelled: false,
    childScope_signalExtWorkflowCancelled: false,
    childScope_consideredCancelled: false,
  });
});

test('CancellableScopes extensive checks - non-cancelleable/non-cancellable - legacy', async (t) => {
  await cancellableScopesExtensiveChecksHelper(t, false, false, true, {
    parentScope_cancelRequestedCancelled: true,
    parentScope_timerCancelled: false,
    parentScope_activityCancelled: false,
    parentScope_localActivityCancelled: false,
    parentScope_signalExtWorkflowCancelled: false,
    parentScope_consideredCancelled: false,

    childScope_cancelRequestedCancelled: true,
    childScope_timerCancelled: false,
    childScope_activityCancelled: false,
    childScope_localActivityCancelled: false,
    childScope_signalExtWorkflowCancelled: false,
    childScope_consideredCancelled: false,
  });
});

export async function cancellationScopeWithTimeoutTimerGetsCancelled(): Promise<[boolean, boolean]> {
  const { activitySleep } = workflow.proxyActivities({ scheduleToCloseTimeout: '7s' });

  // Start in legacy mode, similar to replaying an execution from a pre-1.10.3 workflow
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, false);

  let scope1: workflow.CancellationScope;
  await workflow.CancellationScope.withTimeout('11s', async () => {
    scope1 = workflow.CancellationScope.current();
    await activitySleep(1);
    // Legacy mode: this timer will not be cancelled
  });

  let scope2: workflow.CancellationScope;
  await workflow.CancellationScope.withTimeout('12s', async () => {
    scope2 = workflow.CancellationScope.current();
    await activitySleep(1);
    overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, true);
    // Fix enabled: this timer will get cancelled
  });

  // Timer cancellation won't appear in history if it sent in the same WFT as workflow complete
  await activitySleep(1);

  //@ts-expect-error TSC can't see that scope variables will be initialized synchronously
  return [scope1.consideredCancelled, scope2.consideredCancelled];
}

test('CancellationScope.withTimeout() - timer gets cancelled', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      activitySleep: activity.sleep,
    },
  });
  const handle = await startWorkflow(cancellationScopeWithTimeoutTimerGetsCancelled);
  const [scope1Cancelled, scope2Cancelled] = await worker.runUntil(handle.result());

  t.false(scope1Cancelled);
  t.false(scope2Cancelled);

  const { events } = await handle.fetchHistory();

  const timerCancelledEvents = events?.filter((ev) => ev.timerCanceledEventAttributes) ?? [];
  t.is(timerCancelledEvents?.length, 1);

  const timerStartedEventId = timerCancelledEvents[0].timerCanceledEventAttributes?.startedEventId;
  const timerStartedEvent = events?.find((ev) => ev.eventId?.toNumber() === timerStartedEventId?.toNumber());
  t.is(tsToMs(timerStartedEvent?.timerStartedEventAttributes?.startToFireTimeout), msToNumber('12s'));
});

export async function cancellationScopeWithTimeoutScopeGetCancelledOnTimeout(): Promise<[boolean, boolean]> {
  const { activitySleep } = workflow.proxyActivities({ scheduleToCloseTimeout: '10s' });

  // Start in legacy mode, similar to replaying an execution from a pre-1.10.3 workflow
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, false);
  let scope1: workflow.CancellationScope;
  await workflow.CancellationScope.withTimeout(1, async () => {
    scope1 = workflow.CancellationScope.current();
    await activitySleep(7000);
  }).catch(() => undefined);

  let scope2: workflow.CancellationScope;
  await workflow.CancellationScope.withTimeout(1, async () => {
    scope2 = workflow.CancellationScope.current();
    // Turn on CancellationScopeMultipleFixes to confirm that behavior didn't change
    overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, true);
    await activitySleep(7000);
  }).catch(() => undefined);

  // Activity cancellation won't appear in history if it sent in the same WFT as workflow complete
  await activitySleep(1);

  //@ts-expect-error TSC can't see that scope variables will be initialized synchronously
  return [scope1.consideredCancelled, scope2.consideredCancelled];
}

test('CancellationScope.withTimeout() - scope gets cancelled on timeout', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      activitySleep: activity.sleep,
    },
  });
  const handle = await startWorkflow(cancellationScopeWithTimeoutScopeGetCancelledOnTimeout);
  const [scope1Cancelled, scope2Cancelled] = await worker.runUntil(handle.result());

  t.true(scope1Cancelled);
  t.true(scope2Cancelled);

  const { events } = await handle.fetchHistory();

  const activityCancelledEvents = events?.filter((ev) => ev.activityTaskCancelRequestedEventAttributes) ?? [];
  t.is(activityCancelledEvents?.length, 2);
});

export async function setAndClearTimeout(): Promise<boolean[]> {
  const { activitySleep } = workflow.proxyActivities({ scheduleToCloseTimeout: '10m' });

  // Start in legacy mode, similar to replaying an execution from a pre-1.10.3 workflow
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, false);

  const timerFired: boolean[] = [false, false, false, false, false];

  // This timer will get cleared immediately; it should never fires
  const timer0Handle = setTimeout(() => (timerFired[0] = true), 20_000);
  await activitySleep(1);
  clearTimeout(timer0Handle);

  // This timer will never get cancelled; it should fire
  setTimeout(() => (timerFired[1] = true), 21_000);
  await activitySleep(1);

  // This timer will get cleared after enabling the fix; it should never fire
  const timer2Handle = setTimeout(() => (timerFired[2] = true), 22_000);
  await activitySleep(1);
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, true);
  clearTimeout(timer2Handle);

  // This timer will get cancelled immediately; it should never fire
  const timer3Handle = setTimeout(() => (timerFired[3] = true), 23_000);
  await activitySleep(1);
  clearTimeout(timer3Handle);

  // This timer will never get cancelled; it should fire
  setTimeout(() => (timerFired[4] = true), 24_000);

  // Give time for timers to fire
  await activitySleep('2m');

  return timerFired;
}

export function setAndClearTimeoutInterceptors(): workflow.WorkflowInterceptors {
  return {
    outbound: [
      {
        async startTimer(input, next): Promise<void> {
          // Add 500ms to the duration of the timer; we'll look for that
          return next({ ...input, durationMs: input.durationMs + 500 });
        },
      },
    ],
  };
}

if (RUN_TIME_SKIPPING_TESTS) {
  test.serial('setTimeout and clearTimeout - works before and after 1.10.3', async (t) => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const { createWorker, startWorkflow } = helpers(t, env);
    try {
      const worker = await createWorker({
        activities: {
          activitySleep: env.sleep,
        },
      });
      const handle = await startWorkflow(setAndClearTimeout);
      const timerFired: boolean[] = await worker.runUntil(handle.result());

      t.false(timerFired[0]);
      t.true(timerFired[1]);
      t.false(timerFired[2]);
      t.false(timerFired[3]);
      t.true(timerFired[4]);

      const { events } = await handle.fetchHistory();
      const timerStartedEvents = events?.filter((ev) => ev.timerStartedEventAttributes);
      t.is(timerStartedEvents?.length, 5);
      // Durations that ends with 500ms are the ones that were intercepted
      t.is(tsToMs(timerStartedEvents?.[0].timerStartedEventAttributes?.startToFireTimeout), 20_000);
      t.is(tsToMs(timerStartedEvents?.[1].timerStartedEventAttributes?.startToFireTimeout), 21_000);
      t.is(tsToMs(timerStartedEvents?.[2].timerStartedEventAttributes?.startToFireTimeout), 22_000);
      t.is(tsToMs(timerStartedEvents?.[3].timerStartedEventAttributes?.startToFireTimeout), 23_500);
      t.is(tsToMs(timerStartedEvents?.[4].timerStartedEventAttributes?.startToFireTimeout), 24_500);
    } finally {
      await env.teardown();
    }
  });
}

export async function upsertAndReadMemo(memo: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  workflow.upsertMemo(memo);
  return workflow.workflowInfo().memo;
}

test('Workflow can upsert memo', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(upsertAndReadMemo, {
      memo: {
        alpha: 'bar1',
        bravo: 'bar3',
        charlie: { delta: 'bar2', echo: 12 },
        foxtrot: 'bar4',
      },
      args: [
        {
          alpha: 'bar11',
          bravo: null,
          charlie: { echo: 34, golf: 'bar5' },
          hotel: 'bar6',
        },
      ],
    });
    const result = await handle.result();
    t.deepEqual(result, {
      alpha: 'bar11',
      charlie: { echo: 34, golf: 'bar5' },
      foxtrot: 'bar4',
      hotel: 'bar6',
    });
    const { memo } = await handle.describe();
    t.deepEqual(memo, {
      alpha: 'bar11',
      charlie: { echo: 34, golf: 'bar5' },
      foxtrot: 'bar4',
      hotel: 'bar6',
    });
  });
});

export async function langFlagsReplayCorrectly(): Promise<void> {
  const { noopActivity } = workflow.proxyActivities({ scheduleToCloseTimeout: '10s' });
  await workflow.CancellationScope.withTimeout('10s', async () => {
    await noopActivity();
  });
}

test("Lang's SDK flags replay correctly", async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      noopActivity: () => {},
    },
  });

  const handle = await startWorkflow(langFlagsReplayCorrectly);
  await worker.runUntil(() => handle.result());

  const worker2 = await createWorker();
  await worker2.runUntil(() => handle.query('__stack_trace'));

  // Query would have thrown if the workflow couldn't be replayed correctly
  t.pass();
});

test("Lang's SDK flags - History from before 1.11.0 replays correctly", async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('lang_flags_replay_correctly_1_9_3.json');
  await runReplayHistory({}, hist);
  t.pass();
});

// Context: Due to a bug in 1.11.0 and 1.11.1, SDK flags that were set in those versions were not
// persisted to history. To avoid NDEs on histories produced by those releases, we check the Build
// ID for the SDK version number, and retroactively set some flags on these histories.
test("Lang's SDK flags - Flags from 1.11.[01] are retroactively applied on replay", async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('lang_flags_replay_correctly_1_11_1.json');
  await runReplayHistory({}, hist);
  t.pass();
});

test("Lang's SDK flags from 1.11.2 are retroactively applied on replay", async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('lang_flags_replay_correctly_1_11_2.json');
  await runReplayHistory({}, hist);
  t.pass();
});

export async function cancelAbandonActivityBeforeStarted(): Promise<void> {
  const { activitySleep } = workflow.proxyActivities({
    scheduleToCloseTimeout: '1m',
    cancellationType: ActivityCancellationType.ABANDON,
  });
  const cancelScope = new workflow.CancellationScope({ cancellable: true });
  const prom = cancelScope.run(async () => {
    await activitySleep(1000);
  });
  cancelScope.cancel();
  try {
    await prom;
  } catch {
    // do nothing
  }
}

test('Abandon activity cancel before started works', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      activitySleep: activity.sleep,
    },
  });
  const handle = await startWorkflow(cancelAbandonActivityBeforeStarted);
  await worker.runUntil(handle.result());

  t.pass();
});

export async function WorkflowWillFail(): Promise<string | undefined> {
  if (workflow.workflowInfo().attempt > 1) {
    return workflow.workflowInfo().lastFailure?.message;
  }
  throw ApplicationFailure.retryable('WorkflowWillFail', 'WorkflowWillFail');
}

test("WorkflowInfo().lastFailure contains last run's failure on Workflow Failure", async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const handle = await startWorkflow(WorkflowWillFail, { retry: { maximumAttempts: 2 } });
  await worker.runUntil(async () => {
    const lastFailure = await handle.result();
    t.is(lastFailure, 'WorkflowWillFail');
  });
});

export const interceptors: workflow.WorkflowInterceptorsFactory = () => {
  const interceptorsFactoryFunc = module.exports[`${workflow.workflowInfo().workflowType}Interceptors`];
  if (typeof interceptorsFactoryFunc === 'function') {
    return interceptorsFactoryFunc();
  }
  return {};
};

export async function completableWorkflow(completes: boolean): Promise<void> {
  await workflow.condition(() => completes);
}

test('Count workflow executions', async (t) => {
  const { taskQueue, createWorker, executeWorkflow, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const client = t.context.env.client;

  await worker.runUntil(async () => {
    await Promise.all([
      // Run 2 workflows that will never complete...
      startWorkflow(completableWorkflow, { args: [false] }),
      startWorkflow(completableWorkflow, { args: [false] }),

      // ... and 3 workflows that will complete
      executeWorkflow(completableWorkflow, { args: [true] }),
      executeWorkflow(completableWorkflow, { args: [true] }),
      executeWorkflow(completableWorkflow, { args: [true] }),
    ]);
  });

  // FIXME: Find a better way to wait for visibility to stabilize
  await setTimeoutPromise(1000);

  const actualTotal = await client.workflow.count(`TaskQueue = '${taskQueue}'`);
  t.deepEqual(actualTotal, { count: 5, groups: [] });

  const actualByExecutionStatus = await client.workflow.count(`TaskQueue = '${taskQueue}' GROUP BY ExecutionStatus`);
  t.deepEqual(actualByExecutionStatus, {
    count: 5,
    groups: [
      { count: 2, groupValues: [['Running']] },
      { count: 3, groupValues: [['Completed']] },
    ],
  });
});

test.serial('can register search attributes to dev server', async (t) => {
  const key = defineSearchAttributeKey('new-search-attr', SearchAttributeType.INT);
  const newSearchAttribute: SearchAttributePair = { key, value: 12 };

  // Create new test environment with search attribute registered.
  const env = await createLocalTestEnvironment({
    server: {
      searchAttributes: [key],
    },
  });

  const newClient = env.client;
  // Expect workflow with search attribute to start without error.
  const handle = await newClient.workflow.start(completableWorkflow, {
    args: [true],
    workflowId: randomUUID(),
    taskQueue: 'new-env-tq',
    typedSearchAttributes: [newSearchAttribute],
  });
  // Expect workflow description to have search attribute.
  const desc = await handle.describe();
  t.deepEqual(desc.typedSearchAttributes, new TypedSearchAttributes([newSearchAttribute]));
  t.deepEqual(desc.searchAttributes, { 'new-search-attr': [12] }); // eslint-disable-line deprecation/deprecation
  await env.teardown();
});

export async function rawValueWorkflow(value: unknown, isPayload: boolean = false): Promise<RawValue> {
  const { rawValueActivity } = workflow.proxyActivities({ startToCloseTimeout: '10s' });
  const rv = isPayload
    ? RawValue.fromPayload({
        metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
        data: value as Uint8Array,
      })
    : new RawValue(value);
  return await rawValueActivity(rv, isPayload);
}

test('workflow and activity can receive/return RawValue', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async rawValueActivity(value: unknown, isPayload: boolean = false): Promise<RawValue> {
        const rv = isPayload
          ? RawValue.fromPayload({
              metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
              data: value as Uint8Array,
            })
          : new RawValue(value);
        return rv;
      },
    },
  });

  await worker.runUntil(async () => {
    const testValue = 'test';
    const rawValue = new RawValue(testValue);
    const rawValuePayload = RawValue.fromPayload({
      metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
      data: encode(testValue),
    });
    const res = await executeWorkflow(rawValueWorkflow, {
      args: [rawValue],
    });
    t.deepEqual(res, testValue);
    const res2 = await executeWorkflow(rawValueWorkflow, {
      args: [rawValuePayload, true],
    });
    t.deepEqual(res2, encode(testValue));
  });
});

export async function ChildWorkflowInfo(): Promise<workflow.RootWorkflowInfo | undefined> {
  let blocked = true;
  workflow.setHandler(unblockSignal, () => {
    blocked = false;
  });
  await workflow.condition(() => !blocked);
  return workflow.workflowInfo().root;
}

export async function WithChildWorkflow(childWfId: string): Promise<workflow.RootWorkflowInfo | undefined> {
  return await workflow.executeChild(ChildWorkflowInfo, {
    workflowId: childWfId,
  });
}

test('root execution is exposed', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();

  await worker.runUntil(async () => {
    const childWfId = 'child-wf-id';
    const handle = await startWorkflow(WithChildWorkflow, {
      args: [childWfId],
    });

    const childHandle = t.context.env.client.workflow.getHandle(childWfId);
    const childStarted = async (): Promise<boolean> => {
      try {
        await childHandle.describe();
        return true;
      } catch (e) {
        if (e instanceof workflow.WorkflowNotFoundError) {
          return false;
        } else {
          throw e;
        }
      }
    };
    await waitUntil(childStarted, 8000);
    const childDesc = await childHandle.describe();
    const parentDesc = await handle.describe();

    t.true(childDesc.rootExecution?.workflowId === parentDesc.workflowId);
    t.true(childDesc.rootExecution?.runId === parentDesc.runId);

    await childHandle.signal(unblockSignal);
    const childWfInfoRoot = await handle.result();
    t.true(childWfInfoRoot?.workflowId === parentDesc.workflowId);
    t.true(childWfInfoRoot?.runId === parentDesc.runId);
  });
});

export async function rootWorkflow(): Promise<string> {
  let result = '';
  if (!workflow.workflowInfo().root) {
    result += 'empty';
  } else {
    result += workflow.workflowInfo().root!.workflowId;
  }
  if (!workflow.workflowInfo().parent) {
    result += ' ';
    result += await workflow.executeChild(rootWorkflow);
  }
  return result;
}

test('Workflow can return root workflow', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const result = await executeWorkflow(rootWorkflow, { workflowId: 'test-root-workflow-length' });
    t.deepEqual(result, 'empty test-root-workflow-length');
  });
});

export async function heartbeatCancellationWorkflow(
  state: ActivityState
): Promise<ActivityCancellationDetails | undefined> {
  const { heartbeatCancellationDetailsActivity } = workflow.proxyActivities({
    startToCloseTimeout: '5s',
    retry: {
      maximumAttempts: 2,
    },
    heartbeatTimeout: '1s',
  });

  return await heartbeatCancellationDetailsActivity(state);
}

test('Activity pause returns expected cancellation details', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      heartbeatCancellationDetailsActivity,
    },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(heartbeatCancellationWorkflow, {
      args: [{ pause: true }],
    });

    t.deepEqual(result, {
      cancelRequested: false,
      notFound: false,
      paused: true,
      timedOut: false,
      workerShutdown: false,
      reset: false,
    });
  });
});

test('Activity can be cancelled via pause and retry after unpause', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    activities: {
      heartbeatCancellationDetailsActivity,
    },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(heartbeatCancellationWorkflow, {
      args: [{ pause: true, unpause: true, shouldRetry: true }],
    });
    // Note that we expect the result to be null because unpausing an activity
    // resets the activity context (akin to starting the activity anew)
    t.true(result == null);
  });
});

test('Activity reset without retry returns expected cancellation details', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      heartbeatCancellationDetailsActivity,
    },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(heartbeatCancellationWorkflow, { args: [{ reset: true }] });
    t.deepEqual(result, {
      cancelRequested: false,
      notFound: false,
      paused: false,
      timedOut: false,
      workerShutdown: false,
      reset: true,
    });
  });
});

test('Activity reset with retry returns expected cancellation details', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      heartbeatCancellationDetailsActivity,
    },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(heartbeatCancellationWorkflow, { args: [{ reset: true, shouldRetry: true }] });
    t.true(result == null);
  });
});

test('Activity paused and reset returns expected cancellation details', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      heartbeatCancellationDetailsActivity,
    },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(heartbeatCancellationWorkflow, { args: [{ pause: true, reset: true }] });
    t.deepEqual(result, {
      cancelRequested: false,
      notFound: false,
      paused: true,
      timedOut: false,
      workerShutdown: false,
      reset: true,
    });
  });
});

const reservedNames = [TEMPORAL_RESERVED_PREFIX, STACK_TRACE_QUERY_NAME, ENHANCED_STACK_TRACE_QUERY_NAME];

test('Cannot register activities using reserved prefixes', async (t) => {
  const { createWorker } = helpers(t);

  for (const name of reservedNames) {
    const activityName = name === TEMPORAL_RESERVED_PREFIX ? name + '_test' : name;
    await t.throwsAsync(
      createWorker({
        activities: { [activityName]: () => {} },
      }),
      {
        name: 'TypeError',
        message:
          name === TEMPORAL_RESERVED_PREFIX
            ? `Cannot use activity name: '${activityName}', with reserved prefix: '${name}'`
            : `Cannot use activity name: '${activityName}', which is a reserved name`,
      }
    );
  }
});

test('Cannot register task queues using reserved prefixes', async (t) => {
  const { createWorker } = helpers(t);

  for (const name of reservedNames) {
    const taskQueue = name === TEMPORAL_RESERVED_PREFIX ? name + '_test' : name;

    await t.throwsAsync(
      createWorker({
        taskQueue,
      }),
      {
        name: 'TypeError',
        message:
          name === TEMPORAL_RESERVED_PREFIX
            ? `Cannot use task queue name: '${taskQueue}', with reserved prefix: '${name}'`
            : `Cannot use task queue name: '${taskQueue}', which is a reserved name`,
      }
    );
  }
});

test('Cannot register sinks using reserved prefixes', async (t) => {
  const { createWorker } = helpers(t);

  for (const name of reservedNames) {
    const sinkName = name === TEMPORAL_RESERVED_PREFIX ? name + '_test' : name;
    await t.throwsAsync(
      createWorker({
        sinks: {
          [sinkName]: {
            test: {
              fn: () => {},
            },
          },
        },
      }),
      {
        name: 'TypeError',
        message:
          name === TEMPORAL_RESERVED_PREFIX
            ? `Cannot use sink name: '${sinkName}', with reserved prefix: '${name}'`
            : `Cannot use sink name: '${sinkName}', which is a reserved name`,
      }
    );
  }
});

interface HandlerError {
  name: string;
  message: string;
}

export async function workflowReservedNameHandler(name: string): Promise<HandlerError[]> {
  // Re-package errors, default payload converter has trouble converting native errors (no 'data' field).
  const expectedErrors: HandlerError[] = [];
  try {
    setHandler(defineSignal(name === TEMPORAL_RESERVED_PREFIX ? name + '_signal' : name), () => {});
  } catch (e) {
    if (e instanceof Error) {
      expectedErrors.push({ name: e.name, message: e.message });
    }
  }
  try {
    setHandler(defineUpdate(name === TEMPORAL_RESERVED_PREFIX ? name + '_update' : name), () => {});
  } catch (e) {
    if (e instanceof Error) {
      expectedErrors.push({ name: e.name, message: e.message });
    }
  }
  try {
    setHandler(defineQuery(name === TEMPORAL_RESERVED_PREFIX ? name + '_query' : name), () => {});
  } catch (e) {
    if (e instanceof Error) {
      expectedErrors.push({ name: e.name, message: e.message });
    }
  }
  return expectedErrors;
}

test('Workflow failure if define signals/updates/queries with reserved prefixes', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    for (const name of reservedNames) {
      const result = await executeWorkflow(workflowReservedNameHandler, {
        args: [name],
      });
      t.deepEqual(result, [
        {
          name: 'TypeError',
          message:
            name === TEMPORAL_RESERVED_PREFIX
              ? `Cannot use signal name: '${name}_signal', with reserved prefix: '${name}'`
              : `Cannot use signal name: '${name}', which is a reserved name`,
        },
        {
          name: 'TypeError',
          message:
            name === TEMPORAL_RESERVED_PREFIX
              ? `Cannot use update name: '${name}_update', with reserved prefix: '${name}'`
              : `Cannot use update name: '${name}', which is a reserved name`,
        },
        {
          name: 'TypeError',
          message:
            name === TEMPORAL_RESERVED_PREFIX
              ? `Cannot use query name: '${name}_query', with reserved prefix: '${name}'`
              : `Cannot use query name: '${name}', which is a reserved name`,
        },
      ]);
    }
  });
});

export const wfReadyQuery = defineQuery<boolean>('wf-ready');
export async function workflowWithDefaultHandlers(): Promise<void> {
  let unblocked = false;
  setHandler(defineSignal('unblock'), () => {
    unblocked = true;
  });

  setDefaultQueryHandler(() => {});
  setDefaultSignalHandler(() => {});
  setDefaultUpdateHandler(() => {});
  setHandler(wfReadyQuery, () => true);

  await condition(() => unblocked);
}

test('Default handlers fail given reserved prefix', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();

  const assertWftFailure = async (handle: WorkflowHandle, errMsg: string) => {
    await asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        const wftFailedEvent = history.events?.findLast((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WFT failed event found');
        }
        const { failure } = wftFailedEvent.workflowTaskFailedEventAttributes ?? {};
        if (!failure) {
          return t.fail('Expected failure in workflowTaskFailedEventAttributes');
        }
        t.is(failure.message, errMsg);
      },
      { minTimeout: 300, factor: 1, retries: 10 }
    );
  };

  await worker.runUntil(async () => {
    // Reserved query
    let handle = await startWorkflow(workflowWithDefaultHandlers);
    await asyncRetry(async () => {
      if (!(await handle.query(wfReadyQuery))) {
        throw new Error('Workflow not ready yet');
      }
    });
    const queryName = `${TEMPORAL_RESERVED_PREFIX}_query`;
    await t.throwsAsync(
      handle.query(queryName),
      {
        // TypeError transforms to a QueryNotRegisteredError on the way back from server
        name: 'QueryNotRegisteredError',
        message: `Cannot use query name: '${queryName}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`,
      },
      `Query ${queryName} should fail`
    );
    await handle.terminate();

    // Reserved signal
    handle = await startWorkflow(workflowWithDefaultHandlers);
    await asyncRetry(async () => {
      if (!(await handle.query(wfReadyQuery))) {
        throw new Error('Workflow not ready yet');
      }
    });
    const signalName = `${TEMPORAL_RESERVED_PREFIX}_signal`;
    await handle.signal(signalName);
    await assertWftFailure(
      handle,
      `Cannot use signal name: '${signalName}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`
    );
    await handle.terminate();

    // Reserved update
    handle = await startWorkflow(workflowWithDefaultHandlers);
    await asyncRetry(async () => {
      if (!(await handle.query(wfReadyQuery))) {
        throw new Error('Workflow not ready yet');
      }
    });
    const updateName = `${TEMPORAL_RESERVED_PREFIX}_update`;
    handle.executeUpdate(updateName).catch(() => {
      // Expect failure. The error caught here is a WorkflowNotFound because
      // the workflow will have already failed, so the update cannot go through.
      // We assert on the expected failure below.
    });
    await assertWftFailure(
      handle,
      `Cannot use update name: '${updateName}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`
    );
    await handle.terminate();
  });
});

export async function helloWorkflow(name: string): Promise<string> {
  return `Hello, ${name}!`;
}

test('Workflow can be started eagerly with shared NativeConnection', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const client = new Client({
    connection: t.context.env.nativeConnection,
    namespace: t.context.env.client.options.namespace,
  });

  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(helloWorkflow, {
      args: ['Temporal'],
      workflowId: `eager-workflow-${randomUUID()}`,
      taskQueue,
      requestEagerStart: true,
      workflowTaskTimeout: '1h', // hang if retry needed
    });

    t.true(handle.eagerlyStarted);

    const result = await handle.result();
    t.is(result, 'Hello, Temporal!');
  });
});

test('Error thrown when requestEagerStart is used with regular Connection', async (t) => {
  const { taskQueue } = helpers(t);

  const client = new WorkflowClient({ connection: t.context.env.connection });

  await t.throwsAsync(
    client.start(helloWorkflow, {
      args: ['Temporal'],
      workflowId: `eager-workflow-error-${randomUUID()}`,
      taskQueue,
      requestEagerStart: true,
    }),
    {
      message: /Eager workflow start requires a NativeConnection/,
    }
  );
});

export const bunchOfEventsSignal = defineSignal<[number]>('bunchOfEvents');
export const getHistoryInfoQuery = defineQuery<{
  historyLength: number;
  continueAsNewSuggested: boolean;
  suggestedContinueAsNewReasons: SuggestContinueAsNewReason[] | undefined;
}>('getHistoryInfo');

export async function historyInfoWorkflow(): Promise<void> {
  setHandler(bunchOfEventsSignal, async (count: number) => {
    // Generate events by doing many sleeps
    for (let i = 0; i < count; i++) {
      void workflow.sleep(1);
    }
  });

  setHandler(getHistoryInfoQuery, () => {
    const info = workflow.workflowInfo();
    return {
      historyLength: info.historyLength,
      continueAsNewSuggested: info.continueAsNewSuggested,
      suggestedContinueAsNewReasons: info.suggestedContinueAsNewReasons,
    };
  });

  // Wait forever
  await workflow.condition(() => false);
}

test('suggestedContinueAsNewReasons persists across WFTs', async (t) => {
  if (t.context.env.supportsTimeSkipping) {
    t.pass("Test Server doesn't support continue-as-new suggestion");
    return;
  }

  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();

  await worker.runUntil(async () => {
    const handle = await startWorkflow(historyInfoWorkflow);

    // Initial query - no suggestion yet
    let info = await handle.query(getHistoryInfoQuery);
    t.false(info.continueAsNewSuggested);
    t.is(info.suggestedContinueAsNewReasons, undefined);

    // Send events to trigger CAN suggestion (TOO_MANY_HISTORY_EVENTS)
    // Threshold is set to 50 via limit.historyCount.suggestContinueAsNew in helpers-integration.ts
    await handle.signal(bunchOfEventsSignal, 50);

    // Send one more to trigger WFT update
    await handle.signal(bunchOfEventsSignal, 1);

    // Check suggestion
    info = await handle.query(getHistoryInfoQuery);
    t.true(info.continueAsNewSuggested);
    t.true(info.suggestedContinueAsNewReasons!.length > 0);
    t.true(info.suggestedContinueAsNewReasons!.includes(SuggestContinueAsNewReason.TOO_MANY_HISTORY_EVENTS));

    // Send another event to create new WFT
    await handle.signal(bunchOfEventsSignal, 1);

    // Verify reasons persist
    info = await handle.query(getHistoryInfoQuery);
    t.true(info.continueAsNewSuggested);
    t.true(info.suggestedContinueAsNewReasons!.includes(SuggestContinueAsNewReason.TOO_MANY_HISTORY_EVENTS));

    await handle.cancel();
  });
});
