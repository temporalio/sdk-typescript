import { randomUUID } from 'crypto';
import { firstValueFrom, Subject } from 'rxjs';
import type { ExecutionContext, TestFn } from 'ava';
import { Context as ActivityContext } from '@temporalio/activity';
import type { WorkflowHandle, WorkflowStartOptions } from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter, WorkflowFailedError } from '@temporalio/client';
import type { LocalActivityOptions, RetryPolicy } from '@temporalio/common';
import { msToNumber } from '@temporalio/common/lib/time';
import { temporal } from '@temporalio/proto';
import { workflowInterceptorModules } from '@temporalio/testing';
import type { LogLevel, WorkflowBundle, WorkerOptions } from '@temporalio/worker';
import { bundleWorkflowCode, DefaultLogger, Runtime } from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { test as anyTest, bundlerOptions, Worker, TestWorkflowEnvironment } from './helpers';

// FIXME MOVE THIS SECTION SOMEWHERE IT CAN BE SHARED //

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
      const { interceptors, ...rest } = opts ?? {};
      return await Worker.create({
        connection: t.context.env.nativeConnection,
        workflowBundle: t.context.workflowBundle,
        taskQueue,
        interceptors: {
          activity: interceptors?.activity ?? [],
        },
        showStackTraceSources: true,
        ...rest,
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
    workflowInterceptorModules: [...workflowInterceptorModules, __filename],
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

// END OF TO BE MOVED SECTION //

export async function runOneLocalActivity(s: string): Promise<string> {
  return await workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).echo(s);
}

test.serial('Simple local activity works end to end', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async echo(message: string): Promise<string> {
        return message;
      },
    },
  });
  await worker.runUntil(async () => {
    const res = await executeWorkflow(runOneLocalActivity, {
      args: ['hello'],
    });
    t.is(res, 'hello');
  });
});

export async function runMyLocalActivityWithOption(
  opts: LocalActivityOptions
): Promise<Pick<ActivityContext['info'], 'scheduleToCloseTimeoutMs' | 'startToCloseTimeoutMs'>> {
  return await workflow.proxyLocalActivities(opts).myLocalActivity();
}

test.serial('Local activity with various timeouts', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async myLocalActivity(): Promise<
        Pick<ActivityContext['info'], 'scheduleToCloseTimeoutMs' | 'startToCloseTimeoutMs'>
      > {
        return {
          startToCloseTimeoutMs: ActivityContext.current().info.startToCloseTimeoutMs,
          scheduleToCloseTimeoutMs: ActivityContext.current().info.scheduleToCloseTimeoutMs,
        };
      },
    },
  });
  await worker.runUntil(async () => {
    t.deepEqual(await executeWorkflow(runMyLocalActivityWithOption, { args: [{ startToCloseTimeout: '5s' }] }), {
      startToCloseTimeoutMs: msToNumber('5s'),
      scheduleToCloseTimeoutMs: 0, // FIXME
    });
    t.deepEqual(await executeWorkflow(runMyLocalActivityWithOption, { args: [{ scheduleToCloseTimeout: '5s' }] }), {
      startToCloseTimeoutMs: msToNumber('5s'),
      scheduleToCloseTimeoutMs: msToNumber('5s'),
    });
    t.deepEqual(
      await executeWorkflow(runMyLocalActivityWithOption, {
        args: [{ scheduleToStartTimeout: '2s', startToCloseTimeout: '5s' }],
      }),
      {
        startToCloseTimeoutMs: msToNumber('5s'),
        scheduleToCloseTimeoutMs: 0,
      }
    );
    t.deepEqual(
      await executeWorkflow(runMyLocalActivityWithOption, {
        args: [{ scheduleToCloseTimeout: '5s', startToCloseTimeout: '2s' }],
      }),
      {
        startToCloseTimeoutMs: msToNumber('2s'),
        scheduleToCloseTimeoutMs: msToNumber('5s'),
      }
    );
    t.deepEqual(
      await executeWorkflow(runMyLocalActivityWithOption, {
        args: [{ scheduleToCloseTimeout: '2s', startToCloseTimeout: '5s' }],
      }),
      {
        startToCloseTimeoutMs: msToNumber('2s'),
        scheduleToCloseTimeoutMs: msToNumber('2s'),
      }
    );
  });
});

export async function getIsLocal(fromInsideLocal: boolean): Promise<boolean> {
  return await (fromInsideLocal
    ? workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).isLocal()
    : workflow.proxyActivities({ startToCloseTimeout: '1m' }).isLocal());
}

test.serial('isLocal is set correctly', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async isLocal(): Promise<boolean> {
        return ActivityContext.current().info.isLocal;
      },
    },
  });
  await worker.runUntil(async () => {
    t.is(await executeWorkflow(getIsLocal, { args: [true] }), true);
    t.is(await executeWorkflow(getIsLocal, { args: [false] }), false);
  });
});

export async function runParallelLocalActivities(...ss: string[]): Promise<string[]> {
  return await Promise.all(ss.map(workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).echo));
}

test.serial('Parallel local activities work end to end', async (t) => {
  const { startWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async echo(message: string): Promise<string> {
        return message;
      },
    },
  });
  await worker.runUntil(async () => {
    const args = ['hey', 'ho', 'lets', 'go'];
    const handle = await startWorkflow(runParallelLocalActivities, {
      args,
    });
    const res = await handle.result();
    t.deepEqual(res, args);

    // Double check we have all local activity markers in history
    const history = await handle.fetchHistory();
    const markers = history?.events?.filter(
      (ev) => ev.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
    );
    t.is(markers?.length, 4);
  });
});

export async function throwAnErrorFromLocalActivity(message: string): Promise<void> {
  await workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).throwAnError(message);
}

test.serial('Local activity error is propagated properly to the Workflow', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async throwAnError(message: string): Promise<void> {
        throw ApplicationFailure.nonRetryable(message, 'Error', 'details', 123, false);
      },
    },
  });
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      executeWorkflow(throwAnErrorFromLocalActivity, {
        args: ['tesssst'],
      }),
      { instanceOf: WorkflowFailedError }
    );
    t.is(err?.cause?.message, 'tesssst');
  });
});

export async function cancelALocalActivity(): Promise<void> {
  await workflow.CancellationScope.cancellable(async () => {
    const p = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).myActivity();
    await workflow.sleep(1);
    workflow.CancellationScope.current().cancel();
    await p;
  });
}

test.serial('Local activity cancellation is propagated properly to the Workflow', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async myActivity(): Promise<void> {
        await ActivityContext.current().cancelled;
      },
    },
  });
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      executeWorkflow(cancelALocalActivity, { workflowTaskTimeout: '3s' }),
      { instanceOf: WorkflowFailedError }
    );
    t.true(workflow.isCancellation(err?.cause));
    t.is(err?.cause?.message, 'Local Activity cancelled');
  });
});

test.serial('Worker shutdown while running a local activity completes after completion', async (t) => {
  const { startWorkflow, createWorker } = helpers(t);
  const subj = new Subject<void>();
  const worker = await createWorker({
    activities: {
      async myActivity(): Promise<void> {
        await ActivityContext.current().cancelled;
      },
    },
    sinks: {
      test: {
        timerFired: {
          fn() {
            subj.next();
          },
        },
      },
    },
    // Just in case
    shutdownGraceTime: '10s',
  });
  const handle = await startWorkflow(cancelALocalActivity, { workflowTaskTimeout: '3s' });
  const p = worker.run();
  await firstValueFrom(subj);
  worker.shutdown();

  const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
    instanceOf: WorkflowFailedError,
  });
  t.true(workflow.isCancellation(err?.cause));
  t.is(err?.cause?.message, 'Local Activity cancelled');
  console.log('Local Waiting for worker to complete shutdown');
  await p;
});

test.serial('Failing local activity can be cancelled', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async myActivity(): Promise<void> {
        throw new Error('retry me');
      },
    },
  });
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      executeWorkflow(cancelALocalActivity, { workflowTaskTimeout: '3s' }),
      { instanceOf: WorkflowFailedError }
    );
    t.true(workflow.isCancellation(err?.cause));
    t.is(err?.cause?.message, 'Local Activity cancelled');
  });
});

export async function runSerialLocalActivities(): Promise<void> {
  const { echo } = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' });
  await echo('1');
  await echo('2');
  await echo('3');
}

test.serial('Serial local activities (in the same task) work end to end', async (t) => {
  const { startWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async echo(message: string): Promise<string> {
        return message;
      },
    },
  });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(runSerialLocalActivities, {});
    await handle.result();
    const history = await handle.fetchHistory();
    if (history?.events == null) {
      throw new Error('Expected non null events');
    }
    // Last 3 events before completing the workflow should be MarkerRecorded
    t.truthy(history.events[history.events.length - 2].markerRecordedEventAttributes);
    t.truthy(history.events[history.events.length - 3].markerRecordedEventAttributes);
    t.truthy(history.events[history.events.length - 4].markerRecordedEventAttributes);
  });
});

export async function throwAnExplicitNonRetryableErrorFromLocalActivity(message: string): Promise<void> {
  const { throwAnError } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
    retry: { nonRetryableErrorTypes: ['Error'] },
  });

  await throwAnError(false, message);
}

test.serial('Local activity does not retry if error is in nonRetryableErrorTypes', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async throwAnError(useApplicationFailure: boolean, message: string): Promise<void> {
        if (useApplicationFailure) {
          throw ApplicationFailure.nonRetryable(message, 'Error', 'details', 123, false);
        } else {
          throw new Error(message);
        }
      },
    },
  });
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      executeWorkflow(throwAnExplicitNonRetryableErrorFromLocalActivity, {
        args: ['tesssst'],
      }),
      { instanceOf: WorkflowFailedError }
    );
    t.is(err?.cause?.message, 'tesssst');
  });
});

export async function throwARetryableErrorWithASingleRetry(message: string): Promise<void> {
  const { throwAnError } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
    retry: { maximumAttempts: 2 },
  });

  await throwAnError(false, message);
}

test.serial('Local activity can retry once', async (t) => {
  let attempts = 0;
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      // Reimplement here to track number of attempts
      async throwAnError(_: unknown, message: string) {
        attempts++;
        throw new Error(message);
      },
    },
  });

  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      executeWorkflow(throwARetryableErrorWithASingleRetry, {
        args: ['tesssst'],
      }),
      { instanceOf: WorkflowFailedError }
    );
    t.is(err?.cause?.message, 'tesssst');
  });
  // Might be more than 2 if workflow task times out (CI I'm looking at you)
  t.true(attempts >= 2);
});

export async function throwAnErrorWithBackoff(): Promise<void> {
  const { succeedAfterFirstAttempt } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
    localRetryThreshold: '1s',
    retry: { maximumAttempts: 2, initialInterval: '2s' },
  });

  await succeedAfterFirstAttempt();
}

test.serial('Local activity backs off with timer', async (t) => {
  let attempts = 0;
  const { startWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      // Reimplement here to track number of attempts
      async succeedAfterFirstAttempt() {
        attempts++;
        if (attempts === 1) {
          throw new Error('Retry me please');
        }
      },
    },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(throwAnErrorWithBackoff, {
      workflowTaskTimeout: '3s',
    });
    await handle.result();
    const history = await handle.fetchHistory();
    const timers = history?.events?.filter(
      (ev) => ev.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_TIMER_FIRED
    );
    t.is(timers?.length, 1);

    const markers = history?.events?.filter(
      (ev) => ev.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
    );
    t.is(markers?.length, 2);
  });
});

export async function runOneLocalActivityWithInterceptor(s: string): Promise<string> {
  return await workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).interceptMe(s);
}

test.serial('Local activity can be intercepted', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async interceptMe(message: string): Promise<string> {
        return message;
      },
    },
    interceptors: {
      activity: [
        () => ({
          inbound: {
            async execute(input, next) {
              t.is(defaultPayloadConverter.fromPayload(input.headers.secret), 'shhh');
              return await next(input);
            },
          },
        }),
      ],
    },
  });
  await worker.runUntil(async () => {
    const res = await executeWorkflow(runOneLocalActivityWithInterceptor, {
      args: ['message'],
    });
    t.is(res, 'messagemessage');
  });
});

export async function runNonExisitingLocalActivity(): Promise<void> {
  const { activityNotFound } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
  });

  try {
    await activityNotFound();
  } catch (err) {
    if (err instanceof ReferenceError) {
      return;
    }
    throw err;
  }
  throw ApplicationFailure.nonRetryable('Unreachable');
}

test.serial('Local activity not registered on Worker throws ReferenceError in workflow context', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(executeWorkflow(runNonExisitingLocalActivity));
  t.pass();
});

test.serial('Local activity not registered on replay Worker does not throw', async (t) => {
  const { startWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async echo(input: string) {
        return input;
      },
    },
  });
  const handle = await startWorkflow(runOneLocalActivity, { args: ['hello'] });
  await worker.runUntil(() => handle.result());
  const history = await handle.fetchHistory();
  await Worker.runReplayHistory({ workflowBundle: t.context.workflowBundle }, history, handle.workflowId);
  t.pass();
});

/**
 * Reproduces https://github.com/temporalio/sdk-typescript/issues/731
 */
export async function issue731(): Promise<void> {
  await workflow.CancellationScope.cancellable(async () => {
    const localActivityPromise = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).echo('activity');
    const sleepPromise = workflow.sleep('30s').then(() => 'timer');
    const result = await Promise.race([localActivityPromise, sleepPromise]);
    if (result === 'timer') {
      throw workflow.ApplicationFailure.nonRetryable('Timer unexpectedly beat local activity');
    }
    workflow.CancellationScope.current().cancel();
  });

  await workflow.sleep(100);
}

test.serial('issue-731', async (t) => {
  const { startWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async echo(message: string): Promise<string> {
        return message;
      },
    },
  });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(issue731, {
      workflowTaskTimeout: '1m', // Give our local activities enough time to run in CI
    });
    await handle.result();

    const history = await handle.fetchHistory();
    if (history?.events == null) {
      throw new Error('Expected non null events');
    }
    // Verify only one timer was scheduled
    t.is(history.events.filter(({ timerStartedEventAttributes }) => timerStartedEventAttributes != null).length, 1);
  });
});

export const interceptors: workflow.WorkflowInterceptorsFactory = () => {
  return {
    outbound: [
      {
        async startTimer(input, next) {
          const { test } = workflow.proxySinks();
          await next(input);
          test.timerFired();
        },
        async scheduleLocalActivity(input, next) {
          if (input.activityType !== 'interceptMe') return next(input);

          const secret = workflow.defaultPayloadConverter.toPayload('shhh');
          if (secret === undefined) {
            throw new Error('Unexpected');
          }
          const output: any = await next({ ...input, headers: { secret } });
          return output + output;
        },
      },
    ],
  };
};

export async function getRetryPolicyFromActivityInfo(
  retryPolicy: RetryPolicy,
  fromInsideLocal: boolean
): Promise<object | undefined> {
  return await (fromInsideLocal
    ? workflow.proxyLocalActivities({ startToCloseTimeout: '1m', retry: retryPolicy }).retryPolicy()
    : workflow.proxyActivities({ startToCloseTimeout: '1m', retry: retryPolicy }).retryPolicy());
}

test.serial('retryPolicy is set correctly', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async retryPolicy(): Promise<object | undefined> {
        return ActivityContext.current().info.retryPolicy;
      },
    },
  });

  const retryPolicy: RetryPolicy = {
    backoffCoefficient: 1.5,
    initialInterval: 2.0,
    maximumAttempts: 3,
    maximumInterval: 10.0,
    nonRetryableErrorTypes: ['nonRetryableError'],
  };

  await worker.runUntil(async () => {
    t.deepEqual(await executeWorkflow(getRetryPolicyFromActivityInfo, { args: [retryPolicy, true] }), retryPolicy);
    t.deepEqual(await executeWorkflow(getRetryPolicyFromActivityInfo, { args: [retryPolicy, false] }), retryPolicy);
  });
});

export async function runLocalActivityWithNonLocalActivitiesDisabled(): Promise<string> {
  const { echo } = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' });
  return await echo('hello from local activity');
}

test.serial('Local activities work when enableNonLocalActivities is false', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async echo(message: string): Promise<string> {
        return message;
      },
    },
    enableNonLocalActivities: false,
  });
  await worker.runUntil(async () => {
    const result = await executeWorkflow(runLocalActivityWithNonLocalActivitiesDisabled);
    t.is(result, 'hello from local activity');
  });
});
