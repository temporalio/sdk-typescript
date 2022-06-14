/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as activity from '@temporalio/activity';
import { defaultPayloadConverter, toPayloads } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import anyTest, { ExecutionContext, TestInterface } from 'ava';
import dedent from 'dedent';
import { v4 as uuid4 } from 'uuid';
import { httpGet } from './activities';
import { cleanOptionalStackTrace } from './helpers';
import { defaultOptions, isolateFreeWorker, Worker } from './mock-native-worker';
import { withZeroesHTTPServer } from './zeroes-http-server';

export interface Context {
  worker: Worker;
}

export const test = anyTest as TestInterface<Context>;

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
        input: toPayloads(defaultPayloadConverter, false, message),
      },
    });
    compareCompletion(t, completion.result, {
      failed: {
        failure: {
          message,
          source: 'TypeScriptSDK',
          stackTrace: dedent`
            Error: :(
                at Activity.throwAnError [as fn] (test/src/activities/index.ts)
          `,
          applicationFailureInfo: { type: 'Error', nonRetryable: false },
        },
      },
    });
  });
});

test('Worker cancels activity and reports cancellation', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    worker.native.emit({
      activity: {
        taskToken,
        start: {
          activityType: 'waitForCancellation',
          input: toPayloads(defaultPayloadConverter),
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
        cancelled: { failure: { source: 'TypeScriptSDK', canceledFailureInfo: {} } },
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
        cancelled: { failure: { source: 'TypeScriptSDK', canceledFailureInfo: {} } },
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
        input: toPayloads(defaultPayloadConverter),
      },
    });
    t.regex(
      result?.failed?.failure?.message ?? '',
      /^Activity function notFound is not registered on this Worker, available activities: \[.*"progressiveSleep".*\]/
    );
  });
});

test('Worker cancels activities after shutdown', async (t) => {
  let activityCancelled = false;
  const worker = isolateFreeWorker({
    ...defaultOptions,
    activities: {
      async cancellationSnitch() {
        try {
          await activity.Context.current().cancelled;
        } catch (err) {
          activityCancelled = true;
          throw err;
        }
      },
    },
  });
  t.context.worker = worker;

  const { promise } = await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    return {
      promise: worker.native.runActivityTask({
        taskToken,
        start: {
          activityType: 'cancellationSnitch',
          input: toPayloads(defaultPayloadConverter),
        },
      }),
    };
  });
  // Worker has been shutdown, wait for activity to complete
  const { result } = await promise;

  // The result is failed because an activity shouldn't be resolved as cancelled
  // unless cancellation was requested.
  t.truthy(result?.failed);
  t.true(activityCancelled);
});
