/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { defaultPayloadConverter, toPayloads } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import anyTest, { ExecutionContext, TestInterface } from 'ava';
import dedent from 'dedent';
import { v4 as uuid4 } from 'uuid';
import { httpGet } from './activities';
import { cleanStackTrace } from './helpers';
import { defaultOptions, isolateFreeWorker, Worker } from './mock-native-worker';
import { withZeroesHTTPServer } from './zeroes-http-server';

export interface Context {
  worker: Worker;
}

export const test = anyTest as TestInterface<Context>;

export async function runWorker(t: ExecutionContext<Context>, fn: () => Promise<any>): Promise<void> {
  const { worker } = t.context;
  const promise = worker.run();
  await fn();
  worker.shutdown();
  await promise;
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
    actual = { failed: { failure: { stackTrace: cleanStackTrace(stackTrace), ...rest } } };
  }
  t.deepEqual(
    new coresdk.activity_result.ActivityExecutionResult(actual ?? undefined).toJSON(),
    new coresdk.activity_result.ActivityExecutionResult(expected).toJSON()
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
                at Activity.throwAnError [as fn]
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
      cancel: {},
    });
    compareCompletion(t, completion.result, {
      cancelled: { failure: { source: 'TypeScriptSDK', message: '', canceledFailureInfo: {} } },
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
        cancel: {},
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
