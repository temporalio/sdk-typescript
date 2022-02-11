/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { lastValueFrom } from 'rxjs';
import { SpanContext } from '@opentelemetry/api';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter, msToTs } from '@temporalio/common';
import { Worker as RealWorker, NativeWorkerLike, errors } from '@temporalio/worker/lib/worker';
import {
  compileWorkerOptions,
  CompiledWorkerOptions,
  WorkerOptions,
  addDefaultWorkerOptions,
} from '@temporalio/worker/lib/worker-options';
import { DefaultLogger } from '@temporalio/worker';
import { byteArrayToBuffer } from '@temporalio/worker/lib/utils';
import * as activities from './activities';
import { WorkflowCreator } from '@temporalio/worker/src/workflow/interface';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function addActivityStartDefaults(task: coresdk.activity_task.IActivityTask) {
  // Add some defaults for convenience
  if (task.start) {
    task.start = {
      attempt: 1,
      startedTime: msToTs('0 seconds'),
      currentAttemptScheduledTime: msToTs('0 seconds'),
      startToCloseTimeout: msToTs('1 minute'),
      scheduleToCloseTimeout: msToTs('1 minute'),
      heartbeatTimeout: msToTs('1 minute'),
      scheduledTime: msToTs('0 seconds'),
      ...task.start,
    };
  }
}

export type Task =
  | { workflow: coresdk.workflow_activation.IWorkflowActivation }
  | { activity: coresdk.activity_task.IActivityTask };

export class MockNativeWorker implements NativeWorkerLike {
  flushCoreLogs(): void {
    // noop
  }
  activityTasks: Array<Promise<ArrayBuffer>> = [];
  workflowActivations: Array<Promise<ArrayBuffer>> = [];
  activityCompletionCallback?: (arr: ArrayBuffer) => void;
  workflowCompletionCallback?: (arr: ArrayBuffer) => void;
  activityHeartbeatCallback?: (taskToken: Uint8Array, details: any) => void;
  reject?: (err: Error) => void;
  namespace = 'mock';
  logger = new DefaultLogger('DEBUG');

  public static async create(): Promise<NativeWorkerLike> {
    return new this();
  }

  public static async createReplay(): Promise<NativeWorkerLike> {
    return new this();
  }

  public async completeShutdown(): Promise<void> {
    // Nothing to do here
  }

  public async shutdown(): Promise<void> {
    const shutdownErrorPromise = Promise.reject(new errors.ShutdownError('Core is shut down'));
    this.activityTasks.unshift(shutdownErrorPromise);
    this.workflowActivations.unshift(shutdownErrorPromise);
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

  public async completeWorkflowActivation(_spanContext: SpanContext, result: ArrayBuffer): Promise<void> {
    this.workflowCompletionCallback!(result);
    this.workflowCompletionCallback = undefined;
  }

  public async completeActivityTask(_spanContext: SpanContext, result: ArrayBuffer): Promise<void> {
    this.activityCompletionCallback!(result);
    this.activityCompletionCallback = undefined;
  }

  public emit(task: Task): void {
    if ('workflow' in task) {
      const arr = coresdk.workflow_activation.WorkflowActivation.encode(task.workflow).finish();
      const buffer = byteArrayToBuffer(arr);
      this.workflowActivations.unshift(Promise.resolve(buffer));
    } else {
      addActivityStartDefaults(task.activity);
      const arr = coresdk.activity_task.ActivityTask.encode(task.activity).finish();
      const buffer = byteArrayToBuffer(arr);
      this.activityTasks.unshift(Promise.resolve(buffer));
    }
  }

  public async runWorkflowActivation(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.WorkflowActivationCompletion> {
    const arr = coresdk.workflow_activation.WorkflowActivation.encode(activation).finish();
    const buffer = byteArrayToBuffer(arr);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.workflowCompletionCallback = resolve;
      this.workflowActivations.unshift(Promise.resolve(buffer));
    });
    return coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(new Uint8Array(result));
  }

  public async runActivityTask(task: coresdk.activity_task.IActivityTask): Promise<coresdk.ActivityTaskCompletion> {
    addActivityStartDefaults(task);
    const arr = coresdk.activity_task.ActivityTask.encode(task).finish();
    const buffer = byteArrayToBuffer(arr);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.activityCompletionCallback = resolve;
      this.activityTasks.unshift(Promise.resolve(buffer));
    });
    return coresdk.ActivityTaskCompletion.decodeDelimited(new Uint8Array(result));
  }

  public recordActivityHeartbeat(buffer: ArrayBuffer): void {
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

  public constructor(workflowCreator: WorkflowCreator, opts: CompiledWorkerOptions) {
    const nativeWorker = new MockNativeWorker();
    super(nativeWorker, workflowCreator, opts);
  }

  public runWorkflows(...args: Parameters<Worker['workflow$']>): Promise<void> {
    this.state = 'RUNNING';
    return lastValueFrom(this.workflow$(...args), { defaultValue: undefined });
  }
}

export const defaultOptions: WorkerOptions = {
  workflowsPath: require.resolve('./workflows'),
  activities,
  taskQueue: 'test',
};

export function isolateFreeWorker(options: WorkerOptions = defaultOptions): Worker {
  return new Worker(
    {
      async createWorkflow() {
        throw new Error('Not implemented');
      },
      async destroy() {
        /* Nothing to destroy */
      },
    },
    compileWorkerOptions(addDefaultWorkerOptions(options))
  );
}
