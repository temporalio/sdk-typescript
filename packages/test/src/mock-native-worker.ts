/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { v4 as uuid4 } from 'uuid';
import ivm from 'isolated-vm';
import { coresdk } from '@temporalio/proto';
import { msStrToTs } from '@temporalio/workflow/lib/time';
import { defaultDataConverter } from '@temporalio/workflow/lib/converter/data-converter';
import {
  Worker as RealWorker,
  NativeWorkerLike,
  compileWorkerOptions,
  CompiledWorkerOptionsWithDefaults,
  WorkerOptions,
  addDefaults,
  errors,
} from '@temporalio/worker/lib/worker';
import { WorkflowIsolateBuilder } from '@temporalio/worker/lib/isolate-builder';
import { DefaultLogger } from '@temporalio/worker';
import { sleep } from '@temporalio/worker/lib/utils';

function addActivityStartDefaults(task: coresdk.activity_task.IActivityTask) {
  // Add some defaults for convenience
  if (task.start) {
    task.start = {
      attempt: 1,
      startedTime: msStrToTs('0 seconds'),
      currentAttemptScheduledTime: msStrToTs('0 seconds'),
      startToCloseTimeout: msStrToTs('1 minute'),
      scheduleToCloseTimeout: msStrToTs('1 minute'),
      heartbeatTimeout: msStrToTs('1 minute'),
      scheduledTime: msStrToTs('0 seconds'),
      ...task.start,
    };
  }
}

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
    this.activityTasks.unshift(Promise.reject(new errors.ShutdownError('Core is shut down')));
    this.workflowActivations.unshift(Promise.reject(new errors.ShutdownError('Core is shut down')));
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
      addActivityStartDefaults(task.activity);
      const arr = coresdk.activity_task.ActivityTask.encode(task.activity).finish();
      const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
      this.activityTasks.unshift(Promise.resolve(buffer));
    }
  }

  public emitWorkflowError(error: Error): void {
    this.workflowActivations.unshift(Promise.reject(error));
  }

  public async runWorkflowActivation(
    activation: coresdk.workflow_activation.IWFActivation
  ): Promise<coresdk.workflow_completion.WFActivationCompletion> {
    const arr = coresdk.workflow_activation.WFActivation.encode(activation).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    const result = await new Promise<ArrayBuffer>((resolve) => {
      this.workflowCompletionCallback = resolve;
      this.workflowActivations.unshift(Promise.resolve(buffer));
    });
    return coresdk.workflow_completion.WFActivationCompletion.decodeDelimited(new Uint8Array(result));
  }

  public async runActivityTask(task: coresdk.activity_task.IActivityTask): Promise<coresdk.ActivityTaskCompletion> {
    addActivityStartDefaults(task);
    const arr = coresdk.activity_task.ActivityTask.encode(task).finish();
    const buffer = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
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

  public constructor(
    isolate: ivm.Isolate,
    resolvedActivities: Map<string, Record<string, (...args: any[]) => any>>,
    opts: CompiledWorkerOptionsWithDefaults
  ) {
    const nativeWorker = new MockNativeWorker();
    super(nativeWorker, isolate, resolvedActivities, opts);
  }

  public runWorkflows(...args: Parameters<Worker['workflow$']>): Promise<void> {
    this.state = 'RUNNING';
    return this.workflow$(...args).toPromise();
  }
}

export const defaultOptions: WorkerOptions = {
  workflowsPath: `${__dirname}/workflows`,
  activitiesPath: `${__dirname}/activities`,
  nodeModulesPath: `${__dirname}/../../../node_modules`,
  taskQueue: 'test',
};

export async function makeDefaultWorker(): Promise<Worker> {
  const options = compileWorkerOptions(
    addDefaults({
      ...defaultOptions,
      logger: new DefaultLogger('DEBUG'),
    })
  );
  const resolvedActivities = await WorkflowIsolateBuilder.resolveActivities(options.logger, options.activitiesPath!);
  const builder = new WorkflowIsolateBuilder(
    options.logger,
    options.nodeModulesPath!,
    options.workflowsPath!,
    resolvedActivities,
    options.activityDefaults
  );
  const isolate = await builder.build();
  return new Worker(isolate, resolvedActivities, options);
}

export function isolateFreeWorker(
  options: WorkerOptions = defaultOptions,
  resolvedActivities: Map<string, Record<string, any>> = new Map()
): Worker {
  return new Worker(new ivm.Isolate(), resolvedActivities, compileWorkerOptions(addDefaults(options)));
}
