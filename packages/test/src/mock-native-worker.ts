/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { v4 as uuid4 } from 'uuid';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import {
  Worker as RealWorker,
  NativeWorkerLike,
  WorkerOptions,
  compileWorkerOptions,
  addDefaults,
} from '@temporalio/worker/lib/worker';
import { sleep } from '@temporalio/worker/lib/utils';

export type Task =
  | { workflow: coresdk.workflow_activation.IWFActivation }
  | { activity: coresdk.activity_task.IActivityTask };

export class MockNativeWorker implements NativeWorkerLike {
  activityTasks: Array<Promise<ArrayBuffer>> = [];
  workflowActivations: Array<Promise<ArrayBuffer>> = [];
  activityCompletionCallback?: (arr: ArrayBuffer) => void;
  workflowCompletionCallback?: (arr: ArrayBuffer) => void;
  activityHeartbeatCallback?: (taskToken: Uint8Array, details: any) => void;
  reject?: (err: Error) => void;

  public static async create(): Promise<NativeWorkerLike> {
    return new this();
  }

  public async breakLoop(): Promise<void> {
    // Nothing to break from
  }

  public async shutdown(): Promise<void> {
    this.activityTasks.unshift(Promise.reject(new Error('Core is shut down')));
    this.workflowActivations.unshift(Promise.reject(new Error('Core is shut down')));
  }

  public async pollWorkflowActivation(): Promise<ArrayBuffer> {
    for (;;) {
      const task = this.workflowActivations.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public async pollActivityTask(): Promise<ArrayBuffer> {
    for (;;) {
      const task = this.activityTasks.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public async completeWorkflowActivation(result: ArrayBuffer): Promise<void> {
    this.workflowCompletionCallback!(result);
    this.workflowCompletionCallback = undefined;
  }

  public async completeActivityTask(result: ArrayBuffer): Promise<void> {
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

  public async runActivityTask(task: coresdk.activity_task.IActivityTask): Promise<coresdk.ActivityTaskCompletion> {
    const arr = coresdk.activity_task.ActivityTask.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.activityCompletionCallback = resolve;
      this.activityTasks.unshift(Promise.resolve(buffer));
    });
    return coresdk.ActivityTaskCompletion.decodeDelimited(new Uint8Array(result));
  }

  public async recordActivityHeartbeat(buffer: ArrayBuffer): Promise<void> {
    const { taskToken, details } = coresdk.ActivityHeartbeat.decodeDelimited(new Uint8Array(buffer));
    const arg = defaultDataConverter.fromPayloads(0, details);
    this.activityHeartbeatCallback!(taskToken, arg);
  }

  public async untilHeartbeat(taskToken: Uint8Array): Promise<any> {
    return new Promise((resolve) => {
      this.activityHeartbeatCallback = (heartbeatTaskToken, details) => {
        if (Buffer.from(heartbeatTaskToken).equals(taskToken)) {
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

  public constructor(opts: WorkerOptions) {
    const nativeWorker = new MockNativeWorker();
    super(nativeWorker, compileWorkerOptions(addDefaults(opts)));
  }
}
