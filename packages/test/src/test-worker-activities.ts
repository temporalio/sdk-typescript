/* eslint-disable @typescript-eslint/no-non-null-assertion */
import anyTest, { ExecutionContext, TestFn } from 'ava';
import dedent from 'dedent';
import { v4 as uuid4 } from 'uuid';
import { TemporalFailure, defaultPayloadConverter, toPayloads, ApplicationFailure } from '@temporalio/common';
import { coresdk, google } from '@temporalio/proto';
import { msToTs } from '@temporalio/common/lib/time';
import { httpGet } from './activities';
import { cleanOptionalStackTrace, isBun } from './helpers';
import { defaultOptions, isolateFreeWorker, Worker } from './mock-native-worker';
import { withZeroesHTTPServer } from './zeroes-http-server';
import Duration = google.protobuf.Duration;

export interface Context {
  worker: Worker;
}

export const test = anyTest as TestFn<Context>;

export async function runWorker<T>(t: ExecutionContext<Context>, fn: () => Promise<T>): Promise<T> {
  const { worker } = t.context;
  const promise = worker.run();
  try {
    return await fn();
  } finally {
    worker.shutdown();
    await promise;
  }
}

test.beforeEach(async (t) => {
  const worker = isolateFreeWorker(defaultOptions);

  t.context = {
    worker,
  };
});

function compareCompletion(
  t: ExecutionContext<Context>,
  actual: coresdk.activity_result.IActivityExecutionResult | null | undefined,
  expected: coresdk.activity_result.IActivityExecutionResult
) {
  if (actual?.failed?.failure) {
    const { stackTrace, ...rest } = actual.failed.failure;
    actual = { failed: { failure: { stackTrace: cleanOptionalStackTrace(stackTrace), ...rest } } };
  }
  t.deepEqual(
    coresdk.activity_result.ActivityExecutionResult.create(actual ?? undefined).toJSON(),
    coresdk.activity_result.ActivityExecutionResult.create(expected).toJSON()
  );
}

test('Worker runs an activity and reports completion', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const url = 'https://temporal.io';
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'httpGet',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter, url),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: defaultPayloadConverter.toPayload(await httpGet(url)) },
    });
  });
});

test('Worker runs an activity and reports failure', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const message = ':(';
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'throwAnError',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter, false, message),
      },
    });
    compareCompletion(t, completion.result, {
      failed: {
        failure: {
          message,
          source: 'TypeScriptSDK',
          stackTrace: isBun
            ? dedent`
            Error: :(
                at throwAnError (test/lib/activities/index.js)
                at execute (worker/lib/activity.js)
                at <anonymous> (worker/lib/activity.js)
                at <anonymous> (worker/lib/worker.js)
                at doInnerSub (rxjs/dist/cjs/internal/operators/mergeInternals.js)
                at <anonymous> (rxjs/dist/cjs/internal/operators/OperatorSubscriber.js)
                at <anonymous> (rxjs/dist/cjs/internal/Subscriber.js)
                at <anonymous> (rxjs/dist/cjs/internal/operators/map.js)
                at <anonymous> (rxjs/dist/cjs/internal/operators/OperatorSubscriber.js)`
            : dedent`
            Error: :(
                at throwAnError (test/src/activities/index.ts)
          `,
          applicationFailureInfo: { type: 'Error', nonRetryable: false },
        },
      },
    });
  });
});

const workerCancelsActivityMacro = test.macro(async (t, throwIfAborted?: boolean) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    worker.native.emit({
      activity: {
        taskToken,
        start: {
          activityType: 'waitForCancellation',
          workflowExecution: { workflowId: 'wfid', runId: 'runId' },
          input: toPayloads(defaultPayloadConverter, throwIfAborted),
        },
      },
    });
    const completion = await worker.native.runActivityTask({
      taskToken,
      cancel: {
        reason: coresdk.activity_task.ActivityCancelReason.CANCELLED,
      },
    });
    compareCompletion(t, completion.result, {
      cancelled: {
        failure: {
          source: 'TypeScriptSDK',
          message: 'CANCELLED',
          canceledFailureInfo: {},
        },
      },
    });
  });
});

test('Worker cancels activity and reports cancellation', workerCancelsActivityMacro);

test('Worker cancels activity and reports cancellation when using throwIfAborted', workerCancelsActivityMacro, true);

test('Activity Context AbortSignal cancels a fetch request', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    await withZeroesHTTPServer(async (port) => {
      const taskToken = Buffer.from(uuid4());
      worker.native.emit({
        activity: {
          taskToken,
          start: {
            activityType: 'cancellableFetch',
            workflowExecution: { workflowId: 'wfid', runId: 'runId' },
            input: toPayloads(defaultPayloadConverter, `http://127.0.0.1:${port}`, false),
          },
        },
      });
      const completion = await worker.native.runActivityTask({
        taskToken,
        cancel: {
          reason: coresdk.activity_task.ActivityCancelReason.CANCELLED,
        },
      });
      compareCompletion(t, completion.result, {
        cancelled: { failure: { source: 'TypeScriptSDK', message: 'CANCELLED', canceledFailureInfo: {} } },
      });
    });
  });
});

test('Activity cancel with reason "NOT_FOUND" is valid', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    await withZeroesHTTPServer(async (port) => {
      const taskToken = Buffer.from(uuid4());
      worker.native.emit({
        activity: {
          taskToken,
          start: {
            activityType: 'cancellableFetch',
            workflowExecution: { workflowId: 'wfid', runId: 'runId' },
            input: toPayloads(defaultPayloadConverter, `http://127.0.0.1:${port}`, false),
          },
        },
      });
      const completion = await worker.native.runActivityTask({
        taskToken,
        cancel: {
          reason: coresdk.activity_task.ActivityCancelReason.NOT_FOUND,
        },
      });
      compareCompletion(t, completion.result, {
        cancelled: { failure: { source: 'TypeScriptSDK', message: 'NOT_FOUND', canceledFailureInfo: {} } },
      });
    });
  });
});

test('Activity Context heartbeat is sent to core', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const completionPromise = worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'progressiveSleep',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    console.log('waiting heartbeat 1');
    t.is(await worker.native.untilHeartbeat(taskToken), 1);
    console.log('waiting heartbeat 2');
    t.is(await worker.native.untilHeartbeat(taskToken), 2);
    t.is(await worker.native.untilHeartbeat(taskToken), 3);
    console.log('waiting completion');
    compareCompletion(t, (await completionPromise).result, {
      completed: { result: defaultPayloadConverter.toPayload(undefined) },
    });
  });
});

test('Worker fails activity with proper message when it is not registered', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const { result } = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'notFound',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    t.regex(
      result?.failed?.failure?.message ?? '',
      /^Activity function notFound is not registered on this Worker, available activities: \[.*"progressiveSleep".*\]/
    );
  });
});

test('Worker fails activity with proper message if activity info contains null ScheduledTime', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: {
      async dummy(): Promise<void> {},
    },
  });
  t.context.worker = worker;

  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const { result } = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'dummy',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
        scheduledTime: null,
      },
    });
    t.is(worker.getState(), 'RUNNING');
    t.is(result?.failed?.failure?.applicationFailureInfo?.type, 'TypeError');
    t.is(result?.failed?.failure?.message, 'Expected scheduledTime to be a timestamp, got null');
    t.true(/worker\.[jt]s/.test(result?.failed?.failure?.stackTrace ?? ''));
  });
});

test('Worker fails activity task if interceptor factory throws', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: {
      async dummy(): Promise<void> {},
    },
    interceptors: {
      activity: [
        () => {
          throw new Error('I am a bad interceptor');
        },
      ],
    },
  });
  t.context.worker = worker;

  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const { result } = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'dummy',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    t.is(worker.getState(), 'RUNNING');
    t.is(result?.failed?.failure?.applicationFailureInfo?.type, 'Error');
    t.is(result?.failed?.failure?.message, 'I am a bad interceptor');
    t.true(/test-worker-activities\.[tj]s/.test(result?.failed?.failure?.stackTrace ?? ''));
  });
});

test('Non ApplicationFailure TemporalFailures thrown from Activity are wrapped with ApplicationFailure', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: {
      async throwTemporalFailure() {
        throw new TemporalFailure('I should be valid');
      },
    },
  });
  t.context.worker = worker;

  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const { result } = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'throwTemporalFailure',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    t.is(result?.failed?.failure?.applicationFailureInfo?.type, 'TemporalFailure');
  });
});

test('nextRetryDelay in activity failures is propagated to Core', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: {
      async throwNextDelayFail() {
        throw ApplicationFailure.create({
          message: 'Enchi cat',
          nextRetryDelay: '1s',
        });
      },
    },
  });
  t.context.worker = worker;

  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const { result } = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'throwNextDelayFail',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(defaultPayloadConverter),
      },
    });
    t.deepEqual(result?.failed?.failure?.applicationFailureInfo?.nextRetryDelay, Duration.create(msToTs('1s')));
  });
});
