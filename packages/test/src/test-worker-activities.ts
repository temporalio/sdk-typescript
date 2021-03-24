/* eslint-disable @typescript-eslint/no-non-null-assertion */
import anyTest, { TestInterface, ExecutionContext } from 'ava';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { u8 } from './helpers';
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
  actual: coresdk.TaskCompletion,
  expected: coresdk.ITaskCompletion
) {
  t.deepEqual(actual.toJSON(), coresdk.TaskCompletion.create(expected).toJSON());
}

test('Worker runs an activity and reports completion', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = u8(`${Math.random()}`);
    const url = 'https://temporal.io';
    const completion = await worker.native.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'httpGet']),
          input: defaultDataConverter.toPayloads(url),
        },
      },
    });
    compareCompletion(t, completion, {
      taskToken,
      activity: { completed: { result: defaultDataConverter.toPayloads(await httpGet(url)) } },
    });
  });
});

test('Worker runs an activity and reports failure', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = u8(`${Math.random()}`);
    const message = ':(';
    const completion = await worker.native.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'throwAnError']),
          input: defaultDataConverter.toPayloads(message),
        },
      },
    });
    compareCompletion(t, completion, {
      taskToken,
      activity: { failed: { failure: { message } } },
    });
  });
});

test('Worker cancels activity and reports cancellation', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    worker.native.emit({
      taskToken: u8(`${Math.random}`),
      activity: {
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'waitForCancellation']),
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    const taskToken = u8(`${Math.random()}`);
    const completion = await worker.native.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        cancel: {},
      },
    });
    compareCompletion(t, completion, {
      taskToken,
      activity: { canceled: {} },
    });
  });
});

test('Activity Context AbortSignal cancels a fetch request', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    worker.native.emit({
      taskToken: u8(`${Math.random}`),
      activity: {
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'cancellableFetch']),
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    const taskToken = u8(`${Math.random()}`);
    const completion = await worker.native.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        cancel: {},
      },
    });
    compareCompletion(t, completion, {
      taskToken,
      activity: { canceled: {} },
    });
  });
});

test('Activity Context heartbeat is sent to core', async (t) => {
  const { worker } = t.context;
  await runWorker(t, async () => {
    const taskToken = u8(`${Math.random()}`);
    const completionPromise = worker.native.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        start: {
          activityType: JSON.stringify(['@activities', 'progressiveSleep']),
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    t.is(await worker.native.untilHeartbeat('abc'), 1);
    t.is(await worker.native.untilHeartbeat('abc'), 2);
    t.is(await worker.native.untilHeartbeat('abc'), 3);
    compareCompletion(t, await completionPromise, {
      taskToken,
      activity: { completed: { result: defaultDataConverter.toPayloads(undefined) } },
    });
  });
});
