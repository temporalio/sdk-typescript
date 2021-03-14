/* eslint-disable @typescript-eslint/no-non-null-assertion */
import anyTest, { TestInterface, ExecutionContext } from 'ava';
import * as iface from '@temporalio/proto';
import { testing, NativeWorkerLike } from '@temporalio/worker/lib/worker';
import { PollCallback } from '@temporalio/worker/native';
import { defaultDataConverter, arrayFromPayloads } from '@temporalio/workflow/commonjs/converter/data-converter';
import { u8 } from './helpers';
import { httpGet } from '../../test-activities/lib';

class MockNativeWorker implements NativeWorkerLike {
  callback?: PollCallback;
  completionCallback?: (arr: ArrayBuffer) => void;
  activityHeartbeatCallback?: (activityId: string, details: any) => void;

  public shutdown(): void {
    // Do nothing
  }

  public poll(_queueName: string, callback: PollCallback): void {
    this.callback = callback;
  }

  public isSuspended(): boolean {
    return false;
  }

  public resumePolling(): void {
    // Do nothing
  }

  public suspendPolling(): void {
    // Do nothing
  }

  public completeTask(result: ArrayBuffer): void {
    this.completionCallback!(result);
    this.completionCallback = undefined;
  }

  setCompletionCallback(callback: (arr: ArrayBuffer) => void): void {
    this.completionCallback = callback;
  }

  public emit(task: iface.coresdk.ITask) {
    const arr = iface.coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    this.callback!(undefined, buffer);
  }

  public async runAndWaitCompletion(task: iface.coresdk.ITask): Promise<iface.coresdk.TaskCompletion> {
    const arr = iface.coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.setCompletionCallback(resolve);
      this.callback!(undefined, buffer);
    });
    return iface.coresdk.TaskCompletion.decodeDelimited(new Uint8Array(result));
  }

  sendActivityHeartbeat(activityId: string, details?: ArrayBuffer): void {
    const payloads = details && iface.temporal.api.common.v1.Payloads.decode(new Uint8Array(details));
    const arr = arrayFromPayloads(defaultDataConverter, payloads);
    if (arr.length !== 1) {
      throw new Error('Expected exactly one payload from activity heartbeat');
    }
    this.activityHeartbeatCallback!(activityId, arr[0]);
  }

  public async untilHeartbeat(activityId: string): Promise<any> {
    return new Promise((resolve) => {
      this.activityHeartbeatCallback = (heartbeatActivityId, details) => {
        if (heartbeatActivityId === activityId) {
          resolve(details);
        }
      };
    });
  }
}

class Worker extends testing.BaseWorker {}

export interface Context {
  nativeWorker: MockNativeWorker;
  worker: Worker;
}

const test = anyTest as TestInterface<Context>;

test.beforeEach((t) => {
  const nativeWorker = new MockNativeWorker();
  const worker = new testing.BaseWorker(nativeWorker, __dirname, {
    activitiesPath: `${__dirname}/../../test-activities/lib`,
  });
  t.context = {
    nativeWorker,
    worker,
  };
});

async function runWorker(t: ExecutionContext<Context>, fn: () => Promise<any>) {
  const { nativeWorker, worker } = t.context;
  const promise = worker.run('test');
  await fn();
  nativeWorker.callback!(new Error('[Core::shutdown]'), undefined);
  await promise;
}

function compareCompletion(
  t: ExecutionContext<Context>,
  actual: iface.coresdk.TaskCompletion,
  expected: iface.coresdk.ITaskCompletion
) {
  t.deepEqual(actual.toJSON(), iface.coresdk.TaskCompletion.create(expected).toJSON());
}

test('Worker runs an activity and reports completion', async (t) => {
  const { nativeWorker } = t.context;
  await runWorker(t, async () => {
    const taskToken = u8(`${Math.random()}`);
    const url = 'https://temporal.io';
    const completion = await nativeWorker.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        start: {
          activityType: { name: JSON.stringify(['@activities', 'httpGet']) },
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
  const { nativeWorker } = t.context;
  await runWorker(t, async () => {
    const taskToken = u8(`${Math.random()}`);
    const message = ':(';
    const completion = await nativeWorker.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        start: {
          activityType: { name: JSON.stringify(['@activities', 'throwAnError']) },
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
  const { nativeWorker } = t.context;
  await runWorker(t, async () => {
    nativeWorker.emit({
      taskToken: u8(`${Math.random}`),
      activity: {
        activityId: 'abc',
        start: {
          activityType: { name: JSON.stringify(['@activities', 'waitForCancellation']) },
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    const taskToken = u8(`${Math.random()}`);
    const completion = await nativeWorker.runAndWaitCompletion({
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
  const { nativeWorker } = t.context;
  await runWorker(t, async () => {
    nativeWorker.emit({
      taskToken: u8(`${Math.random}`),
      activity: {
        activityId: 'abc',
        start: {
          activityType: { name: JSON.stringify(['@activities', 'cancellableFetch']) },
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    const taskToken = u8(`${Math.random()}`);
    const completion = await nativeWorker.runAndWaitCompletion({
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
  const { nativeWorker } = t.context;
  await runWorker(t, async () => {
    const taskToken = u8(`${Math.random()}`);
    const completionPromise = nativeWorker.runAndWaitCompletion({
      taskToken,
      activity: {
        activityId: 'abc',
        start: {
          activityType: { name: JSON.stringify(['@activities', 'progressiveSleep']) },
          input: defaultDataConverter.toPayloads(),
        },
      },
    });
    t.is(await nativeWorker.untilHeartbeat('abc'), 1);
    t.is(await nativeWorker.untilHeartbeat('abc'), 2);
    t.is(await nativeWorker.untilHeartbeat('abc'), 3);
    compareCompletion(t, await completionPromise, {
      taskToken,
      activity: { completed: { result: defaultDataConverter.toPayloads(undefined) } },
    });
  });
});
