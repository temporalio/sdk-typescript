/* eslint-disable @typescript-eslint/no-non-null-assertion */
import test from 'ava';
import * as iface from '@temporalio/proto';
import { testing, NativeWorkerLike } from '@temporalio/worker/lib/worker';
import { PollCallback } from '@temporalio/worker/native';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { u8 } from './helpers';
import { httpGet } from '../../test-activities/lib';

class MockNativeWorker implements NativeWorkerLike {
  callback?: PollCallback;
  completionCallback?: (arr: ArrayBuffer) => void;

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

  public async runAndWaitCompletion(task: iface.coresdk.ITask): Promise<iface.coresdk.TaskCompletion> {
    const arr = iface.coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.setCompletionCallback(resolve);
      this.callback!(undefined, buffer);
    });
    return iface.coresdk.TaskCompletion.decodeDelimited(new Uint8Array(result));
  }
}

test('Worker runs an activity and reports completion', async (t) => {
  const nativeWorker = new MockNativeWorker();
  const worker = new testing.BaseWorker(nativeWorker, __dirname, {
    activitiesPath: `${__dirname}/../../test-activities/lib`,
  });
  const promise = worker.run('test');
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
  t.deepEqual(
    completion.toJSON(),
    iface.coresdk.TaskCompletion.create({
      taskToken,
      activity: { completed: { result: defaultDataConverter.toPayloads(await httpGet(url)) } },
    }).toJSON()
  );
  nativeWorker.callback!(new Error('[Core::shutdown]'), undefined);
  await promise;
});
