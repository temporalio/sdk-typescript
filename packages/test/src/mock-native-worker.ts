/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as iface from '@temporalio/proto';
import { defaultDataConverter, arrayFromPayloads } from '@temporalio/workflow/commonjs/converter/data-converter';
import { testing, NativeWorkerLike } from '@temporalio/worker/lib/worker';
import { sleep } from '@temporalio/worker/lib/utils';

export class MockNativeWorker implements NativeWorkerLike {
  tasks: Array<Promise<ArrayBuffer>> = [];
  reject?: (err: Error) => void;
  completionCallback?: (arr: ArrayBuffer) => void;
  activityHeartbeatCallback?: (activityId: string, details: any) => void;

  public shutdown(): void {
    this.tasks.unshift(Promise.reject(new Error('[Core::shutdown]')));
  }

  public async poll(_queueName: string): Promise<ArrayBuffer> {
    for (;;) {
      const task = this.tasks.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public completeTask(result: ArrayBuffer): void {
    this.completionCallback!(result);
    this.completionCallback = undefined;
  }

  public emit(task: iface.coresdk.ITask): void {
    const arr = iface.coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    this.tasks.unshift(Promise.resolve(buffer));
  }

  public async runAndWaitCompletion(task: iface.coresdk.ITask): Promise<iface.coresdk.TaskCompletion> {
    const arr = iface.coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.completionCallback = resolve;
      this.tasks.unshift(Promise.resolve(buffer));
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

export class Worker extends testing.BaseWorker {}
