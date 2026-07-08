import { firstValueFrom, Subject } from 'rxjs';
import * as activity from '@temporalio/activity';
import { tsToMs } from '@temporalio/common/lib/time';
import type { CancelReason } from '@temporalio/worker/lib/activity';
import { ApplicationFailure } from '@temporalio/common';
import { signalSchedulingWorkflow } from './activities/helpers';
import { activityStartedSignal } from './workflows/definitions';
import { heartbeatCancellationDetailsActivity } from './activities/heartbeat-cancellation-details';
import {
  cancelFakeProgress,
  heartbeatCancellationWorkflow,
  runDelayedRetryActivities,
  runTestActivity,
} from './integration-workflows-common';
import { helpers, makeTestFunction } from './helpers-integration';

export * from './integration-workflows-common';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

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
