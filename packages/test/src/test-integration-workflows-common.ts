import type { ExecutionContext } from 'ava';
import * as activity from '@temporalio/activity';
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
import type { ActivityCancellationDetails } from '@temporalio/common';
import {
  ActivityCancellationType,
  ApplicationFailure,
  encodingKeys,
  METADATA_ENCODING_KEY,
  RawValue,
} from '@temporalio/common';
import {
  TEMPORAL_RESERVED_PREFIX,
  STACK_TRACE_QUERY_NAME,
  ENHANCED_STACK_TRACE_QUERY_NAME,
} from '@temporalio/common/lib/reserved';
import { activityStartedSignal } from './workflows/definitions';
import type { Context } from './helpers-integration';
import { helpers } from './helpers-integration';
import { overrideSdkInternalFlag } from './mock-internal-flags';
import type { ActivityState } from './activities/heartbeat-cancellation-details';

export async function parent(): Promise<void> {
  await workflow.startChild(child, { workflowId: 'child' });
  await workflow.startChild(child, { workflowId: 'child' });
}

export async function child(): Promise<void> {
  await workflow.CancellationScope.current().cancelRequested;
}

export async function runTestActivity(activityOptions?: workflow.ActivityOptions): Promise<void> {
  await workflow.proxyActivities({ startToCloseTimeout: '1m', ...activityOptions }).testActivity();
}

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

export async function conditionTimeout0(): Promise<boolean | undefined> {
  return await workflow.condition(() => false, 0);
}

export async function historySizeGrows(): Promise<[number, number]> {
  const before = workflow.workflowInfo().historySize;
  await workflow.sleep(1);
  const after = workflow.workflowInfo().historySize;
  return [before, after];
}

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

export async function conflictId(): Promise<void> {
  await workflow.condition(() => false);
}

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

export async function dontExecuteEagerActivity(): Promise<string> {
  return (await workflow
    .proxyActivities({ scheduleToCloseTimeout: '5s', allowEagerDispatch: true })
    .testActivity()
    .catch(() => 'failed')) as string;
}

export const unblockSignal = defineSignal('unblock');
export const getBuildIdQuery = defineQuery<string>('getBuildId');

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

export interface CancellableScopesExtensiveChecks {
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

export async function cancellableScopesExtensiveChecksHelper(
  t: ExecutionContext<Context>,
  parentCancellable: boolean,
  childCancellable: boolean,
  legacyCompatibility: boolean,
  expected: CancellableScopesExtensiveChecks
): Promise<void> {
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

export async function upsertAndReadMemo(memo: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  workflow.upsertMemo(memo);
  return workflow.workflowInfo().memo;
}

export async function langFlagsReplayCorrectly(): Promise<void> {
  const { noopActivity } = workflow.proxyActivities({ scheduleToCloseTimeout: '10s' });
  await workflow.CancellationScope.withTimeout('10s', async () => {
    await noopActivity();
  });
}

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

export async function WorkflowWillFail(): Promise<string | undefined> {
  if (workflow.workflowInfo().attempt > 1) {
    return workflow.workflowInfo().lastFailure?.message;
  }
  throw ApplicationFailure.retryable('WorkflowWillFail', 'WorkflowWillFail');
}

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

export const reservedNames = [TEMPORAL_RESERVED_PREFIX, STACK_TRACE_QUERY_NAME, ENHANCED_STACK_TRACE_QUERY_NAME];

export interface HandlerError {
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

export async function helloWorkflow(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
