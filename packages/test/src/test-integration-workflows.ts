import { randomUUID } from 'crypto';
import { ExecutionContext } from 'ava';
import { firstValueFrom, Subject } from 'rxjs';
import { WorkflowFailedError } from '@temporalio/client';
import * as activity from '@temporalio/activity';
import { tsToMs } from '@temporalio/common/lib/time';
import { CancelReason } from '@temporalio/worker/lib/activity';
import * as workflow from '@temporalio/workflow';
import { defineQuery, defineSignal } from '@temporalio/workflow';
import { SdkFlags } from '@temporalio/workflow/lib/flags';
import { signalSchedulingWorkflow } from './activities/helpers';
import { activityStartedSignal } from './workflows/definitions';
import * as workflows from './workflows';
import { Context, helpers, makeTestFunction } from './helpers-integration';
import { overrideSdkInternalFlag } from './mock-internal-flags-interceptor';

const test = makeTestFunction({ workflowsPath: __filename });

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
  const { createWorker, startWorkflow } = helpers(t);

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
  const workflowWorker = await createWorker({
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
  const { createWorker, startWorkflow } = helpers(t);

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
  const workflowWorker = await createWorker({
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
    return workflow.workflowInfo().currentBuildId ?? '';
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

// Repro for https://github.com/temporalio/sdk-typescript/issues/1423
export async function issue1423Workflow(legacyCompatibility: boolean): Promise<'threw' | 'didnt-throw'> {
  overrideSdkInternalFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation, !legacyCompatibility);
  try {
    workflow.CancellationScope.current().cancel();
    // This will throw a CancellationException
    await workflow.sleep(1);
    throw workflow.ApplicationFailure.nonRetryable('sleep in cancelled scope didnt throw'); // Shouldn't happen
  } catch (err) {
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

  const { someActivity } = workflow.proxyActivities({ scheduleToCloseTimeout: 5000, taskQueue: 'non-existant' });
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
  const childScope = new workflow.CancellationScope({ cancellable: childCancellable, parent: parentScope });
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
