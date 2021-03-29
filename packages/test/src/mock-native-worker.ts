/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { v4 as uuid4 } from 'uuid';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { Worker as RealWorker, NativeWorkerLike, WorkerOptions } from '@temporalio/worker/lib/worker';
import { sleep } from '@temporalio/worker/lib/utils';

export type Task =
  | { workflow: coresdk.workflow_activation.IWFActivation }
  | { activity: coresdk.activity_task.IActivityTask };

export interface ActivityCompletion {
  taskToken?: Uint8Array | null;
  result: coresdk.activity_result.ActivityResult;
}

export class MockNativeWorker implements NativeWorkerLike {
  activityTasks: Array<Promise<ArrayBuffer>> = [];
  workflowActivations: Array<Promise<ArrayBuffer>> = [];
  activityCompletionCallback?: (arr: ArrayBuffer) => void;
  workflowCompletionCallback?: (arr: ArrayBuffer) => void;
  activityHeartbeatCallback?: (activityId: string, details: any) => void;
  reject?: (err: Error) => void;

  public static async create(): Promise<NativeWorkerLike> {
    return new this();
  }

  public shutdown(): void {
    this.activityTasks.unshift(Promise.reject(new Error('[Core::shutdown]')));
    this.workflowActivations.unshift(Promise.reject(new Error('[Core::shutdown]')));
  }

  public async pollWorkflowActivation(_queueName: string): Promise<ArrayBuffer> {
    for (;;) {
      const task = this.workflowActivations.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public async pollActivityTask(_queueName: string): Promise<ArrayBuffer> {
    for (;;) {
      const task = this.activityTasks.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public completeWorkflowActivation(result: ArrayBuffer): void {
    this.workflowCompletionCallback!(result);
    this.workflowCompletionCallback = undefined;
  }

  public completeActivityTask(result: ArrayBuffer): void {
    this.activityCompletionCallback!(result);
    this.activityCompletionCallback = undefined;
  }

  public emit(task: Task): void {
    if ('workflow' in task) {
      const arr = coresdk.workflow_activation.WFActivation.encode(task.workflow).finish();
      const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
      this.workflowActivations.unshift(Promise.resolve(buffer));
    } else {
      const arr = coresdk.activity_task.ActivityTask.encode(task.activity).finish();
      const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
      this.activityTasks.unshift(Promise.resolve(buffer));
    }
  }

  public async runWorkflowActivation(
    activation: coresdk.workflow_activation.IWFActivation
  ): Promise<coresdk.workflow_completion.WFActivationCompletion> {
    activation = { ...activation, taskToken: activation.taskToken ?? Buffer.from(uuid4()) };
    const arr = coresdk.workflow_activation.WFActivation.encode(activation).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.workflowCompletionCallback = resolve;
      this.workflowActivations.unshift(Promise.resolve(buffer));
    });
    return coresdk.workflow_completion.WFActivationCompletion.decodeDelimited(new Uint8Array(result));
  }

  public async runActivityTask(task: coresdk.activity_task.IActivityTask): Promise<ActivityCompletion> {
    const arr = coresdk.activity_task.ActivityTask.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.activityCompletionCallback = resolve;
      this.activityTasks.unshift(Promise.resolve(buffer));
    });
    return {
      taskToken: task.taskToken,
      result: coresdk.activity_result.ActivityResult.decodeDelimited(new Uint8Array(result)),
    };
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

export class Worker extends RealWorker {
  protected static nativeWorkerCtor = MockNativeWorker;

  public get native(): MockNativeWorker {
    return this.nativeWorker as MockNativeWorker;
  }

  public constructor(pwd: string, opts?: WorkerOptions) {
    const nativeWorker = new MockNativeWorker();
    super(nativeWorker, pwd, opts);
  }
}
