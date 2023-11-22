import { firstValueFrom, Subject } from 'rxjs';
import { WorkflowFailedError } from '@temporalio/client';
import * as activity from '@temporalio/activity';
import { tsToMs } from '@temporalio/common/lib/time';
import { CancelReason } from '@temporalio/worker/lib/activity';
import * as workflow from '@temporalio/workflow';
import { signalSchedulingWorkflow } from '../activities/helpers';
import { activityStartedSignal } from '../workflows/definitions';
import { helpers, makeTestFunction } from './helpers';

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
