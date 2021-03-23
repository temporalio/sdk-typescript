/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
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

  public emit(task: coresdk.ITask): void {
    const arr = coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    this.tasks.unshift(Promise.resolve(buffer));
  }

  public async runAndWaitCompletion(task: coresdk.ITask): Promise<coresdk.TaskCompletion> {
    const arr = coresdk.Task.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.completionCallback = resolve;
      this.tasks.unshift(Promise.resolve(buffer));
    });
    return coresdk.TaskCompletion.decodeDelimited(new Uint8Array(result));
  }

  sendActivityHeartbeat(activityId: string, details?: ArrayBuffer): void {
    const payload = details && coresdk.common.Payload.decode(new Uint8Array(details));
    const arg = payload ? defaultDataConverter.fromPayload(payload) : undefined;
    this.activityHeartbeatCallback!(activityId, arg);
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
