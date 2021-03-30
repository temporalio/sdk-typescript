/* eslint-disable @typescript-eslint/no-non-null-assertion */
import anyTest, { TestInterface, ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { httpGet } from '../../test-activities/lib';
import { Worker } from './mock-native-worker';

export interface Context {
  worker: Worker;
}

export const test = anyTest as TestInterface<Context>;

export async function runWorker(t: ExecutionContext<Context>, fn: () => Promise<any>): Promise<void> {
  const { worker } = t.context;
  const promise = worker.run('test');
  await fn();
  worker.shutdown();
  await promise;
}

test.beforeEach((t) => {
  const worker = new Worker(__dirname, {
    activitiesPath: `${__dirname}/../../test-activities/lib`,
  });
  t.context = {
    worker,
  };
});

function compareCompletion(
  t: ExecutionContext<Context>,
  actual: coresdk.activity_result.IActivityResult | null | undefined,
  expected: coresdk.activity_result.IActivityResult
) {
  t.deepEqual(
    coresdk.activity_result.ActivityResult.create(actual || undefined).toJSON(),
    coresdk.activity_result.ActivityResult.create(expected).toJSON()
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
        input: defaultDataConverter.toPayloads(url),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: defaultDataConverter.toPayload(await httpGet(url)) },
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
        input: defaultDataConverter.toPayloads(message),
      },
    });
    compareCompletion(t, completion.result, {
      failed: { failure: { message } },
    });
  });
});

test('Worker cancels activity and reports cancellation', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    worker.native.emit({
      activity: {
        taskToken: Buffer.from(uuid4()),
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'waitForCancellation']),
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      activityId: 'abc',
      cancel: {},
    });
    compareCompletion(t, completion.result, {
      canceled: {},
    });
  });
});

test('Activity Context AbortSignal cancels a fetch request', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    worker.native.emit({
      activity: {
        taskToken: Buffer.from(uuid4()),
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'cancellableFetch']),
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      activityId: 'abc',
      cancel: {},
    });
    compareCompletion(t, completion.result, {
      canceled: {},
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
        input: defaultDataConverter.toPayloads(),
      },
    });
    t.is(await worker.native.untilHeartbeat('abc'), 1);
    t.is(await worker.native.untilHeartbeat('abc'), 2);
    t.is(await worker.native.untilHeartbeat('abc'), 3);
    compareCompletion(t, (await completionPromise).result, {
      completed: { result: defaultDataConverter.toPayload(undefined) },
    });
  });
});
