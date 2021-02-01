import { resolve } from 'path';
import { Observable, partition } from 'rxjs';
import { groupBy, mergeMap, mergeScan } from 'rxjs/operators';
import { coresdk } from '../proto/core-interface';
import {
  newWorker,
  workerPoll,
  workerIsSuspended,
  workerResumePolling,
  workerSuspendPolling,
  workerCompleteTask,
  Worker as NativeWorker,
} from '../native';
import { Workflow } from './workflow';
import { ActivityOptions } from './activity';

export interface WorkerOptions {
  activityDefaults?: ActivityOptions;
  /**
   * Path to use as alias for the `@activities` import and registration
   * defaults to `../activities`
   */
  activitiesPath?: string;
  /**
   * Path to use as alias for the `@activities` import
   * defaults to `../workflows`
   */
  workflowsPath?: string;

  /**
  * @defaultValue `true`
  */
  autoRegisterActivities?: boolean, // defaults to true
  autoRegisterWorkflows?: boolean,  // defaults to true

  maxConcurrentActivityExecutionSize?: number, // defaults to 200
  maxConcurrentLocalActivityExecutionSize?: number, // defaults to 200
  getMaxConcurrentWorkflowTaskExecutionSize?: number, // defaults to 200
  getMaxTaskQueueActivitiesPerSecond?: number,
  getMaxWorkerActivitiesPerSecond?: number,
  isLocalActivityWorkerOnly?: boolean, // defaults to false
}

export function getDefaultOptions(dirname: string): WorkerOptions {
  return {
    activitiesPath: resolve(dirname, '../activities'),
    workflowsPath: resolve(dirname, '../workflows'),
    autoRegisterActivities: true,
    autoRegisterWorkflows: true,
  };
};

export class Worker {
  public readonly options: WorkerOptions;
  nativeWorker?: NativeWorker;

  /**
   * Create a new `Worker`, `pwd` is used to resolve relative paths for locating and importing activities and workflows.
   */
  constructor(public readonly pwd: string, options?: WorkerOptions) {
    // TODO: merge activityDefaults
    this.options = { ...getDefaultOptions(pwd), ...options };
  }

  /**
   * Do not make new poll requests.
   */
  public suspendPolling(): void {
    if (this.nativeWorker === undefined) {
      throw new Error('Not running');
    }
    workerSuspendPolling(this.nativeWorker);
  }

  /**
   * Allow new poll requests.
   */
  public resumePolling(): void {
    if (this.nativeWorker === undefined) {
      throw new Error('Not running');
    }
    workerResumePolling(this.nativeWorker);
  }

  public isSuspended(): boolean {
    if (this.nativeWorker === undefined) {
      throw new Error('Not running');
    }
    return workerIsSuspended(this.nativeWorker);
  }

  /**
   * Manually register workflows, e.g. for when using a non-standard directory structure.
   */
  public async registerWorkflows(_nameToPath: Record<string, string>): Promise<void> {
    // Not implemented yet
  }

  /**
   * Manually register activities, e.g. for when using a non-standard directory structure.
   */
  public async registerActivities(_importPathToImplementation: Record<string, Record<string, Function>>): Promise<void> {
    // Not implemented yet
  }

  async run(queueName: string) {
    const native = newWorker(queueName);
    this.nativeWorker = native;
    const poller$ = new Observable<coresdk.Task>((subscriber) => {
      workerPoll(native, (err, buffer) => {
        // TODO: this shouldn't happen in the non-mocked version
        if (err && err.message === 'No tasks to perform for now') {
          subscriber.complete();
          return;
        }
        if (buffer === undefined) {
          subscriber.error(err);
          return;
        }
        const task = coresdk.Task.decode(new Uint8Array(buffer));
        subscriber.next(task);
        return () => {}; // TODO: shutdown worker if no subscribers
      });
    });
    type TaskForWorkflow = Required<{ taskToken: coresdk.ITask['taskToken'], workflow: coresdk.WorkflowTask }>;
    type TaskForActivity = Required<{ taskToken: coresdk.ITask['taskToken'], workflow: coresdk.ActivityTask }>;
    const [workflow$] = partition(poller$, (task) => task.variant === 'workflow') as any as [Observable<TaskForWorkflow>, Observable<TaskForActivity>];

    return await workflow$
      .pipe(
        groupBy((task) => task.workflow.runId),
        mergeMap((group$) => {
          return group$.pipe(
            mergeScan(async (workflow: Workflow | undefined, task) => {
              if (workflow === undefined) {
                if (!task.workflow.startWorkflow) {

                  throw new Error('Expected StartWorkflow');
                }
                workflow = await Workflow.create(task.workflow.startWorkflow.workflowId!);
                await workflow.inject('console.log', console.log);
                // TODO: get script name from task params
                const scriptName = process.argv[process.argv.length - 1];
                await workflow.registerImplementation(scriptName);
              }
              const encodedWorkflowTask = coresdk.WorkflowTask.encodeDelimited(task.workflow).finish();
              const arr = await workflow.activate(task.taskToken!, encodedWorkflowTask);
              workerCompleteTask(native, arr.buffer.slice(arr.byteOffset));
              return workflow;
            }, undefined, 1 /* concurrency */))
        })
      )
      .toPromise();
  }
}
