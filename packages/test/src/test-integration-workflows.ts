import { randomUUID } from 'crypto';
import { firstValueFrom, Subject } from 'rxjs';
import { WorkflowFailedError } from '@temporalio/client';
import * as activity from '@temporalio/activity';
import { tsToMs } from '@temporalio/common/lib/time';
import { CancelReason } from '@temporalio/worker/lib/activity';
import * as workflow from '@temporalio/workflow';
import { defineQuery, defineSignal } from '@temporalio/workflow';
import { signalSchedulingWorkflow } from './activities/helpers';
import { activityStartedSignal } from './workflows/definitions';
import * as workflows from './workflows';
import { helpers, makeTestFunction } from './helpers-integration';

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
  const batchSize = 100;
  if (workflow.workflowInfo().continueAsNewSuggested) {
    return false;
  }
  while (workflow.workflowInfo().historyLength < maxEvents) {
    await Promise.all(new Array(batchSize).fill(undefined).map((_) => workflow.sleep(1)));
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

export async function executeEagerActivity(): Promise<void> {
  const scheduleActivity = () =>
    workflow
      .proxyActivities({ scheduleToCloseTimeout: '5s', allowEagerDispatch: true })
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

const finishSignal = defineSignal('finish');
const getBuildIdQuery = defineQuery<string>('getBuildId');

export async function buildIdTester(): Promise<void> {
  const { echo } = workflow.proxyActivities({ startToCloseTimeout: '5s' });
  let doFinish = false;

  workflow.setHandler(finishSignal, () => {
    doFinish = true;
  });
  workflow.setHandler(getBuildIdQuery, () => {
    return workflow.workflowInfo().currentBuildId ?? '';
  });

  await workflow.sleep(1);
  if (workflow.workflowInfo().currentBuildId === '1.0') {
    await echo('hi');
  }

  await workflow.condition(() => doFinish);
}

test('Build Id appropriately set in workflow info', async (t) => {
  const { taskQueue, createWorker } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;
  const activities = {
    async echo(s: string) {
      return s;
    },
  };

  const worker1 = await createWorker({
    buildId: '1.0',
    activities,
  });

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

  const worker2 = await createWorker({
    buildId: '1.1',
    activities,
  });

  await worker2.runUntil(async () => {
    const handle = await client.workflow.getHandle(wfid);

    t.is(await handle.query(getBuildIdQuery), '1.0');

    await handle.signal(finishSignal);
    await handle.result();

    t.is(await handle.query(getBuildIdQuery), '1.1');
  });
});
