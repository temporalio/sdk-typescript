/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { lastValueFrom } from 'rxjs';
import { SdkComponent, defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import { msToTs } from '@temporalio/common/lib/time';
import { coresdk } from '@temporalio/proto';
import { DefaultLogger, Runtime, ShutdownError } from '@temporalio/worker';
import { byteArrayToBuffer } from '@temporalio/worker/lib/utils';
import { NativeReplayHandle, NativeWorkerLike, Worker as RealWorker } from '@temporalio/worker/lib/worker';
import { LoggerWithComposedMetadata } from '@temporalio/common/lib/logger';
import { MetricMeterWithComposedTags } from '@temporalio/common/lib/metrics';
import { CompiledWorkerOptions, compileWorkerOptions, WorkerOptions } from '@temporalio/worker/lib/worker-options';
import type { WorkflowCreator } from '@temporalio/worker/lib/workflow/interface';
import * as activities from './activities';

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
  public readonly type = 'worker';
  flushCoreLogs(): void {
    // noop
  }
  activityTasks: Array<Promise<Buffer>> = [];
  workflowActivations: Array<Promise<Buffer>> = [];
  activityCompletionCallback?: (arr: Buffer) => void;
  workflowCompletionCallback?: (arr: Buffer) => void;
  activityHeartbeatCallback?: (taskToken: Uint8Array, details: any) => void;
  reject?: (err: Error) => void;
  namespace = 'mock';
  logger = new DefaultLogger('DEBUG');

  public static async create(): Promise<NativeWorkerLike> {
    return new this();
  }

  public static async createReplay(): Promise<NativeReplayHandle> {
    return { worker: new this(), historyPusher: { type: 'history-pusher' } };
  }

  public async finalizeShutdown(): Promise<void> {
    // Nothing to do here
  }

  public initiateShutdown(): void {
    const shutdownErrorPromise = Promise.reject(new ShutdownError('Core is shut down'));
    shutdownErrorPromise.catch(() => {
      /* avoid unhandled rejection */
    });
    this.activityTasks.unshift(shutdownErrorPromise);
    this.workflowActivations.unshift(shutdownErrorPromise);
  }

  public async pollWorkflowActivation(): Promise<Buffer> {
    for (;;) {
      const task = this.workflowActivations.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public async pollActivityTask(): Promise<Buffer> {
    for (;;) {
      const task = this.activityTasks.pop();
      if (task !== undefined) {
        return task;
      }
      await sleep(1);
    }
  }

  public async completeWorkflowActivation(result: Buffer): Promise<void> {
    this.workflowCompletionCallback!(result);
    this.workflowCompletionCallback = undefined;
  }

  public async pollNexusTask(): Promise<Buffer> {
    // Not implementing this in the mock worker, testing with real worker instead.
    throw new Error('not implemented');
  }

  public async completeActivityTask(result: Buffer): Promise<void> {
    this.activityCompletionCallback!(result);
    this.activityCompletionCallback = undefined;
  }

  public async completeNexusTask(_result: Buffer): Promise<void> {
    // Not implementing this in the mock worker, testing with real worker instead.
    throw new Error('not implemented');
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
    const result = await new Promise<Buffer>((resolve) => {
      this.workflowCompletionCallback = resolve;
      this.workflowActivations.unshift(Promise.resolve(buffer));
    });
    return coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(new Uint8Array(result));
  }

  public async runActivityTask(task: coresdk.activity_task.IActivityTask): Promise<coresdk.ActivityTaskCompletion> {
    addActivityStartDefaults(task);
    const arr = coresdk.activity_task.ActivityTask.encode(task).finish();
    const buffer = byteArrayToBuffer(arr);
    const result = await new Promise<Buffer>((resolve) => {
      this.activityCompletionCallback = resolve;
      this.activityTasks.unshift(Promise.resolve(buffer));
    });
    return coresdk.ActivityTaskCompletion.decodeDelimited(new Uint8Array(result));
  }

  public recordActivityHeartbeat(buffer: Buffer): void {
    const { taskToken, details } = coresdk.ActivityHeartbeat.decodeDelimited(new Uint8Array(buffer));
    const arg = fromPayloadsAtIndex(defaultPayloadConverter, 0, details);
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
    const runtime = Runtime.instance();
    const logger = LoggerWithComposedMetadata.compose(runtime.logger, {
      sdkComponent: SdkComponent.worker,
      taskQueue: opts.taskQueue,
    });
    const nativeWorker = new MockNativeWorker();
    super(runtime, nativeWorker, workflowCreator, opts, logger, runtime.metricMeter, opts.plugins ?? []);
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
  const runtime = Runtime.instance();
  const logger = LoggerWithComposedMetadata.compose(runtime.logger, {
    sdkComponent: SdkComponent.worker,
    taskQueue: options.taskQueue ?? 'default',
  });
  const metricMeter = MetricMeterWithComposedTags.compose(runtime.metricMeter, {
    namespace: options.namespace ?? 'default',
    taskQueue: options.taskQueue ?? 'default',
  });
  return new Worker(
    {
      async createWorkflow() {
        throw new Error('Not implemented');
      },
      async destroy() {
        /* Nothing to destroy */
      },
    },
    compileWorkerOptions(options, logger, metricMeter)
  );
}
