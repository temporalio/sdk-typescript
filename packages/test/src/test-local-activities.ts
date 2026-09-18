import { firstValueFrom, Subject } from 'rxjs';
import { Context as ActivityContext } from '@temporalio/activity';
import { ApplicationFailure, defaultPayloadConverter, WorkflowFailedError } from '@temporalio/client';
import { msToNumber } from '@temporalio/common/lib/time';
import { temporal } from '@temporalio/proto';
import * as workflow from '@temporalio/workflow';
import type { LocalActivityOptions } from '@temporalio/workflow';
import { Worker } from '@temporalio/test-helpers';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  cancelALocalActivity,
  getIsLocal,
  interceptors,
  issue731,
  runLocalActivityWithNonLocalActivitiesDisabled,
  runMyLocalActivityWithOption,
  runNonExisitingLocalActivity,
  runOneLocalActivity,
  runOneLocalActivityWithInterceptor,
  runParallelLocalActivities,
  runSerialLocalActivities,
  runUnregisteredLocalActivityWithDefaultWorkflow,
  throwARetryableErrorWithASingleRetry,
  throwAnErrorFromLocalActivity,
  throwAnErrorWithBackoff,
  throwAnExplicitNonRetryableErrorFromLocalActivity,
} from './workflows/local-activities';

const test = makeTestFunction({
  workflowInterceptorModules: [require.resolve('./workflows/local-activities')],
  workflowEnvironmentOpts: {
    server: {
      // eager activities do not propagate retry policy
      // see https://github.com/temporalio/temporal/pull/11357
      extraArgs: ['--dynamic-config-value', 'system.enableActivityEagerExecution=false'],
    },
  },
});

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

test.serial('Local activity not registered on Worker throws ReferenceError in workflow context', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(executeWorkflow(runNonExisitingLocalActivity));
  t.pass();
});

test.serial('Local activity falls back to default activity when type is not registered', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async default(): Promise<string> {
        return 'from-default';
      },
    },
  });
  await worker.runUntil(async () => {
    t.is(await executeWorkflow(runUnregisteredLocalActivityWithDefaultWorkflow), 'from-default');
  });
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
