/* eslint-disable @typescript-eslint/no-non-null-assertion */
import anyTest, { TestInterface, ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/common';
import { WorkflowIsolateBuilder } from '@temporalio/worker/lib/isolate-builder';
import { DefaultLogger } from '@temporalio/worker/lib/logger';
import { httpGet } from './activities';
import { Worker, isolateFreeWorker, defaultOptions } from './mock-native-worker';
import { withZeroesHTTPServer } from './zeroes-http-server';
import { cleanStackTrace } from './helpers';

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
  const resolvedActivities = await WorkflowIsolateBuilder.resolveActivities(
    new DefaultLogger('ERROR'),
    defaultOptions.activitiesPath!
  );
  const worker = isolateFreeWorker(defaultOptions, resolvedActivities);

  t.context = {
    worker,
  };
});

function compareCompletion(
  t: ExecutionContext<Context>,
  actual: coresdk.activity_result.IActivityResult | null | undefined,
  expected: coresdk.activity_result.IActivityResult
) {
  if (actual?.failed?.failure) {
    const { stackTrace, ...rest } = actual.failed.failure;
    actual = { failed: { failure: { stackTrace: cleanStackTrace(stackTrace), ...rest } } };
  }
  t.deepEqual(
    new coresdk.activity_result.ActivityResult(actual ?? undefined).toJSON(),
    new coresdk.activity_result.ActivityResult(expected).toJSON()
  );
}

test('Worker runs an activity and reports completion', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const url = 'https://temporal.io';
    const completion = await worker.native.runActivityTask({
      taskToken,
      activityId: 'abc',
      start: {
        activityType: JSON.stringify(['@activities', 'httpGet']),
        input: await defaultDataConverter.toPayloads(url),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: await defaultDataConverter.toPayload(await httpGet(url)) },
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
      activityId: 'abc',
      start: {
        activityType: JSON.stringify(['@activities', 'throwAnError']),
        input: await defaultDataConverter.toPayloads(message),
      },
    });
    compareCompletion(t, completion.result, {
      failed: {
        failure: {
          message,
          source: 'NodeSDK',
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
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'waitForCancellation']),
          input: await defaultDataConverter.toPayloads(),
        },
      },
    });
    const completion = await worker.native.runActivityTask({
      taskToken,
      activityId: 'abc',
      cancel: {},
    });
    compareCompletion(t, completion.result, {
      cancelled: { failure: { source: 'NodeSDK', canceledFailureInfo: {} } },
    });
  });
});

test('Activity Context AbortSignal cancels a fetch request', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    await withZeroesHTTPServer(async (port, finished) => {
      const taskToken = Buffer.from(uuid4());
      worker.native.emit({
        activity: {
          taskToken,
          activityId: 'abc',
          start: {
            activityType: JSON.stringify(['@activities', 'cancellableFetch']),
            input: await defaultDataConverter.toPayloads(`http://127.0.0.1:${port}`, false),
          },
        },
      });
      const completion = await worker.native.runActivityTask({
        taskToken,
        activityId: 'abc',
        cancel: {},
      });
      compareCompletion(t, completion.result, {
        cancelled: { failure: { source: 'NodeSDK', canceledFailureInfo: {} } },
      });
      await finished;
    });
  });
});

test('Activity Context heartbeat is sent to core', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = Buffer.from(uuid4());
    const completionPromise = worker.native.runActivityTask({
      taskToken,
      activityId: 'abc',
      start: {
        activityType: JSON.stringify(['@activities', 'progressiveSleep']),
        input: await defaultDataConverter.toPayloads(),
      },
    });
    console.log('waiting heartbeat 1');
    t.is(await worker.native.untilHeartbeat(taskToken), 1);
    console.log('waiting heartbeat 2');
    t.is(await worker.native.untilHeartbeat(taskToken), 2);
    t.is(await worker.native.untilHeartbeat(taskToken), 3);
    console.log('waiting completion');
    compareCompletion(t, (await completionPromise).result, {
      completed: { result: await defaultDataConverter.toPayload(undefined) },
    });
  });
});
