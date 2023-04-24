import { randomUUID } from 'crypto';
import { ExecutionContext, TestFn } from 'ava';
import { firstValueFrom, Subject } from 'rxjs';
import { WorkflowFailedError, WorkflowHandle, WorkflowStartOptions } from '@temporalio/client';
import { TestWorkflowEnvironment, workflowInterceptorModules } from '@temporalio/testing';
import * as iface from '@temporalio/proto';
import { tsToMs } from '@temporalio/common/lib/time';
import {
  appendDefaultInterceptors,
  bundleWorkflowCode,
  DefaultLogger,
  LogLevel,
  Runtime,
  WorkerOptions,
  WorkflowBundle,
} from '@temporalio/worker';
import * as activity from '@temporalio/activity';
import * as workflow from '@temporalio/workflow';
import { CancelReason } from '@temporalio/worker/src/activity';
import { test as anyTest, bundlerOptions, Worker } from './helpers';
import { activityStartedSignal } from './workflows/definitions';
import { signalSchedulingWorkflow } from './activities/helpers';
import { ConnectionInjectorInterceptor } from './activities/interceptors';

const { EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_MARKER_RECORDED } = iface.temporal.api.enums.v1.EventType;
const CHANGE_MARKER_NAME = 'core_patch';

interface Context {
  env: TestWorkflowEnvironment;
  workflowBundle: WorkflowBundle;
}

const test = anyTest as TestFn<Context>;

interface Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  executeWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<workflow.WorkflowResultType<T>>;
  executeWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<workflow.WorkflowResultType<T>>;
  startWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<WorkflowHandle<T>>;
  startWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<WorkflowHandle<T>>;
}

function helpers(t: ExecutionContext<Context>): Helpers {
  const taskQueue = t.title.replace(/ /g, '_');

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: t.context.env.nativeConnection,
        workflowBundle: t.context.workflowBundle,
        taskQueue,
        interceptors: appendDefaultInterceptors({
          activityInbound: [() => new ConnectionInjectorInterceptor(t.context.env.connection)],
        }),
        showStackTraceSources: true,
        ...opts,
      });
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<any> {
      return await t.context.env.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<WorkflowHandle<workflow.Workflow>> {
      return await t.context.env.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
  };
}

test.before(async (t) => {
  // Ignore invalid log levels
  Runtime.install({ logger: new DefaultLogger((process.env.TEST_LOG_LEVEL || 'DEBUG').toUpperCase() as LogLevel) });
  const env = await TestWorkflowEnvironment.createLocal();
  const workflowBundle = await bundleWorkflowCode({
    ...bundlerOptions,
    workflowInterceptorModules,
    workflowsPath: __filename,
  });
  t.context = {
    env,
    workflowBundle,
  };
});

test.after.always(async (t) => {
  await t.context.env.teardown();
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

export async function runTestActivity(): Promise<void> {
  await workflow.proxyActivities({ startToCloseTimeout: '1m' }).testActivity();
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

export async function conditionTimeout0Simple(): Promise<boolean | undefined> {
  let validationTimerFired = false;
  // Don't lower this value, otherwise, in CI, there is risk that the timer fire
  // while the WFT is being processed, which would result in an UnhandledCommand.
  workflow
    .sleep(10_000)
    .then(() => (validationTimerFired = true))
    .catch((e) => console.log(e));

  return await workflow.condition(() => validationTimerFired, 0);
}

test('Internal patches does not cause non-determinism error on replay', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({
    // Disable workflow caching, to force replay after the condition's sleep
    maxCachedWorkflows: 0,
  });
  await worker.runUntil(async () => {
    try {
      await executeWorkflow(conditionTimeout0Simple);
      t.pass();
    } catch (e) {
      t.fail((e as Error).message);
    }
  });
});

test('Condition with timeout 0 does not block indefinitely', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(conditionTimeout0Simple);
    t.false(await handle.result());
    const history = await handle.fetchHistory();

    const timerStartedEvents = history.events?.filter(({ eventType }) => eventType === EVENT_TYPE_TIMER_STARTED);
    t.is(timerStartedEvents?.length, 2);
    t.is(timerStartedEvents?.[0].timerStartedEventAttributes?.timerId, '1');
    t.is(tsToMs(timerStartedEvents?.[0].timerStartedEventAttributes?.startToFireTimeout), 10000);
    t.is(timerStartedEvents?.[1].timerStartedEventAttributes?.timerId, '2');
    t.is(tsToMs(timerStartedEvents?.[1].timerStartedEventAttributes?.startToFireTimeout), 1);

    const markersEvents = history.events?.filter(({ eventType }) => eventType === EVENT_TYPE_MARKER_RECORDED);
    t.is(markersEvents?.length, 1);
    t.is(markersEvents?.[0].markerRecordedEventAttributes?.markerName, CHANGE_MARKER_NAME);
  });
});
