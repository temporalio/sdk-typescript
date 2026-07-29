import * as activity from '@temporalio/activity';
import { msToNumber, tsToMs } from '@temporalio/common/lib/time';
import {
  cancelAbandonActivityBeforeStarted,
  cancellableScopesExtensiveChecksHelper,
  cancellationScopeWithTimeoutScopeGetCancelledOnTimeout,
  cancellationScopeWithTimeoutTimerGetsCancelled,
  nonCancellableScopesBeforeAndAfterWorkflow,
} from './integration-workflows-common';
import { helpers, makeTestFunction } from './helpers-integration';

export * from './integration-workflows-common';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

test('Propagation of cancellation from non-cancellable scopes - before vs after', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const [childScope1Cancelled, childScope2Cancelled] = await worker.runUntil(
    executeWorkflow(nonCancellableScopesBeforeAndAfterWorkflow)
  );
  t.true(childScope1Cancelled);
  t.false(childScope2Cancelled);
});

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
