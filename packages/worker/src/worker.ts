import { resolve } from 'path';
import { Observable, partition } from 'rxjs';
import { groupBy, mapTo, mergeMap } from 'rxjs/operators';
import { coresdk } from '@temporalio/proto';
import {
  newWorker,
  workerShutdown,
  workerPoll,
  workerIsSuspended,
  workerResumePolling,
  workerSuspendPolling,
  workerCompleteTask,
  Worker as NativeWorker,
} from '../native';
import { mergeMapWithState } from './rxutils';
import { Workflow } from './workflow';
import { resolveFilename, LoaderError } from './loader';
import { ActivityOptions } from './activity';

export interface WorkerOptions {
  activityDefaults?: ActivityOptions;
  /**
   * Path to look up activities in.
   * Use as alias for the `@activities` import.
   * defaults to `../activities`
   * pass `null` to manually register activities
   */
  activitiesPath?: string | null;
  /**
   * Path to look up workflows in.
   * defaults to `../workflows`
   * pass `null` to manually register workflows
   */
  workflowsPath?: string | null;

  // TODO: implement all of these
  maxConcurrentActivityExecutions?: number; // defaults to 200
  maxConcurrentLocalActivityExecutions?: number; // defaults to 200
  maxConcurrentWorkflowTaskExecutions?: number; // defaults to 200
  maxTaskQueueActivitiesPerSecond?: number;
  maxWorkerActivitiesPerSecond?: number;
  isLocalActivityWorkerOnly?: boolean; // defaults to false
}

export type WorkerOptionsWithDefaults = Required<Pick<WorkerOptions, 'activitiesPath' | 'workflowsPath'>>;

export const resolver = (baseDir: string | null, overrides: Map<string, string>) => async (
  lookupName: string
): Promise<string> => {
  const resolved = overrides.get(lookupName);
  if (resolved !== undefined) return resolved;
  if (baseDir === null) {
    throw new LoaderError(`Could not find ${lookupName} in overrides and no baseDir provided`);
  }

  return await resolveFilename(resolve(baseDir, lookupName));
};

export function getDefaultOptions(dirname: string): WorkerOptionsWithDefaults {
  return {
    activitiesPath: resolve(dirname, '../activities'),
    workflowsPath: resolve(dirname, '../workflows'),
  };
}

export class Worker {
  public readonly options: WorkerOptionsWithDefaults;
  protected readonly workflowOverrides: Map<string, string> = new Map();
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
  public async registerWorkflows(nameToPath: Record<string, string>): Promise<void> {
    for (const [name, path] of Object.entries(nameToPath)) {
      this.workflowOverrides.set(name, path);
    }
  }

  /**
   * Manually register activities, e.g. for when using a non-standard directory structure.
   */
  public async registerActivities(
    _importPathToImplementation: Record<string, Record<string, () => any>>
  ): Promise<void> {
    // Not implemented yet
  }

  shutdown(): void {
    if (this.nativeWorker === undefined) {
      throw new Error('Not running');
    }
    workerShutdown(this.nativeWorker);
  }

  async run(queueName: string): Promise<void> {
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
        return () => undefined; // TODO: shutdown worker if no subscribers
      });
    });
    type TaskForWorkflow = Required<{ taskToken: Uint8Array; workflow: coresdk.WFActivation }>;
    type TaskForActivity = Required<{ taskToken: Uint8Array; workflow: coresdk.ActivityTask }>;
    const [workflow$] = (partition(poller$, (task) => task.variant === 'workflow') as any) as [
      Observable<TaskForWorkflow>,
      Observable<TaskForActivity>
    ];

    return await workflow$
      .pipe(
        groupBy((task) => task.workflow.runId),
        mergeMap((group$) => {
          return group$.pipe(
            mergeMapWithState(async (workflow: Workflow | undefined, task) => {
              if (workflow === undefined) {
                // Find a workflow start job in the activation jobs list
                // TODO: should this always be the first job in the list?
                const maybeStartWorkflow = task.workflow.jobs.find((j) => j.startWorkflow);
                if (maybeStartWorkflow !== undefined) {
                  const attrs = maybeStartWorkflow.startWorkflow;
                  if (!(attrs && attrs.workflowId && attrs.workflowType)) {
                    throw new Error(
                      `Expected StartWorkflow with workflowId and workflowType, got ${JSON.stringify(
                        maybeStartWorkflow
                      )}`
                    );
                  }
                  workflow = await Workflow.create(attrs.workflowId);
                  // TODO: this probably shouldn't be here, consider alternative implementation
                  await workflow.inject('console.log', console.log);
                  const scriptName = await resolver(
                    this.options.workflowsPath,
                    this.workflowOverrides
                  )(attrs.workflowType);
                  await workflow.registerImplementation(scriptName);
                } else {
                  throw new Error('Received workflow activation for an untracked workflow with no start workflow job');
                }
              }

              const arr = await workflow.activate(task.taskToken, task.workflow);
              workerCompleteTask(native, arr.buffer.slice(arr.byteOffset));
              return { state: workflow, output: arr };
            }, undefined)
          );
        }),
        mapTo(undefined)
      )
      .toPromise();
  }
}
