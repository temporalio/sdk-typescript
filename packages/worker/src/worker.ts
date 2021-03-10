import { basename, extname, resolve } from 'path';
import { readdirSync } from 'fs';
import { merge, Observable, OperatorFunction, partition, pipe } from 'rxjs';
import { groupBy, map, mergeMap, share, tap } from 'rxjs/operators';
import ms from 'ms';
import { coresdk, temporal } from '@temporalio/proto';
import { ActivityOptions } from '@temporalio/workflow';
import {
  DataConverter,
  defaultDataConverter,
  arrayFromPayloads,
} from '@temporalio/workflow/commonjs/converter/data-converter';
import {
  newWorker,
  workerShutdown,
  workerPoll,
  workerIsSuspended,
  workerResumePolling,
  workerSuspendPolling,
  workerCompleteTask,
} from '../native';
import { sleep } from './utils';
import { mergeMapWithState } from './rxutils';
import { resolveFilename, LoaderError } from './loader';
import { Workflow } from './workflow';
import { Activity } from './activity';

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
  /**
   * Time to wait for pending tasks to drain after receiving a shutdown signal.
   * @see {@link shutdownSignals}
   *
   * @format ms formatted string
   */
  shutdownGraceTime?: string;

  /**
   * Automatically shut down worker on any of these signals.
   * @default ['SIGINT', 'SIGTERM', 'SIGQUIT']
   */
  shutdownSignals?: NodeJS.Signals[];

  /**
   * TODO: document, figure out how to propagate this to the workflow isolate
   */
  dataConverter?: DataConverter;

  // TODO: implement all of these
  maxConcurrentActivityExecutions?: number; // defaults to 200
  maxConcurrentLocalActivityExecutions?: number; // defaults to 200
  maxConcurrentWorkflowTaskExecutions?: number; // defaults to 200
  maxTaskQueueActivitiesPerSecond?: number;
  maxWorkerActivitiesPerSecond?: number;
  isLocalActivityWorkerOnly?: boolean; // defaults to false
}

export type WorkerOptionsWithDefaults = WorkerOptions &
  Required<
    Pick<WorkerOptions, 'activitiesPath' | 'workflowsPath' | 'shutdownGraceTime' | 'shutdownSignals' | 'dataConverter'>
  >;

export interface CompiledWorkerOptionsWithDefaults extends WorkerOptionsWithDefaults {
  shutdownGraceTimeMs: number;
}

export const resolver = (baseDir: string | null, overrides: Map<string, string>) => async (
  lookupName: string
): Promise<string> => {
  const resolved = overrides.get(lookupName);
  if (resolved !== undefined) return resolved;
  if (baseDir === null) {
    throw new LoaderError(`Could not find ${lookupName} in overrides and no baseDir provided`);
  }

  return resolveFilename(resolve(baseDir, lookupName));
};

export function getDefaultOptions(dirname: string): WorkerOptionsWithDefaults {
  return {
    activitiesPath: resolve(dirname, '../activities'),
    workflowsPath: resolve(dirname, '../workflows'),
    shutdownGraceTime: '5s',
    shutdownSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT'],
    dataConverter: defaultDataConverter,
  };
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptionsWithDefaults {
  return { ...opts, shutdownGraceTimeMs: ms(opts.shutdownGraceTime) };
}

export type State = 'INITIALIZED' | 'RUNNING' | 'STOPPED' | 'STOPPING' | 'FAILED';

type TaskForWorkflow = Required<{ taskToken: Uint8Array; workflow: coresdk.WFActivation }>;
type TaskForActivity = Required<{ taskToken: Uint8Array; activity: coresdk.ActivityTask }>;

export class Worker {
  public readonly options: CompiledWorkerOptionsWithDefaults;
  protected readonly workflowOverrides: Map<string, string> = new Map();
  protected readonly resolvedActivities: Map<string, Record<string, () => any>>;
  nativeWorker = newWorker();
  _state: State = 'INITIALIZED';

  /**
   * Create a new Worker.
   * This method immediately connects to the server and will throw on connection failure.
   * @param pwd - Used to resolve relative paths for locating and importing activities and workflows.
   */
  constructor(public readonly pwd: string, options?: WorkerOptions) {
    // TODO: merge activityDefaults
    this.options = compileWorkerOptions({ ...getDefaultOptions(pwd), ...options });
    this.resolvedActivities = new Map();
    if (this.options.activitiesPath !== null) {
      const files = readdirSync(this.options.activitiesPath, { encoding: 'utf8' });
      for (const file in files) {
        const ext = extname(file);
        if (ext === '.js') {
          const fullPath = resolve(this.options.activitiesPath, file);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const module = require(fullPath);
          const functions = Object.fromEntries(
            Object.entries(module).filter((entry): entry is [string, () => any] => entry[1] instanceof Function)
          );
          const importName = basename(file, ext);
          console.log('Loaded activity', { importName, fullPath });
          this.resolvedActivities.set(`@activities/${importName}`, functions);
          if (importName === 'index') {
            this.resolvedActivities.set('@activities', functions);
          }
        }
      }
    }
  }

  /**
   * Get the poll state of this worker
   */
  public getState(): State {
    // Setters and getters require the same visibility, add this public getter function
    return this._state;
  }

  get state(): State {
    return this._state;
  }

  set state(state: State) {
    // TODO: use logger
    console.log('Worker state changed', { state });
    this._state = state;
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
    importPathToImplementation: Record<string, Record<string, () => any>>
  ): Promise<void> {
    for (const [name, functions] of Object.entries(importPathToImplementation)) {
      // TODO: check that functions are actually functions
      this.resolvedActivities.set(name, functions);
    }
  }

  /**
   * Do not make new poll requests.
   */
  public suspendPolling(): void {
    if (this.state !== 'RUNNING') {
      throw new Error('Not running');
    }
    workerSuspendPolling(this.nativeWorker);
  }

  /**
   * Allow new poll requests.
   */
  public resumePolling(): void {
    if (this.state !== 'RUNNING') {
      throw new Error('Not running');
    }
    workerResumePolling(this.nativeWorker);
  }

  public isSuspended(): boolean {
    if (this.state !== 'RUNNING') {
      throw new Error('Not running');
    }
    return workerIsSuspended(this.nativeWorker);
  }

  shutdown(): void {
    if (this.state !== 'RUNNING') {
      throw new Error('Not running');
    }
    this.state = 'STOPPING';
    workerShutdown(this.nativeWorker);
  }

  protected poller$(queueName: string): Observable<coresdk.Task> {
    if (this.state !== 'INITIALIZED') {
      throw new Error('Poller was aleady started');
    }
    return new Observable<coresdk.Task>((subscriber) => {
      const startShutdownSequence = async (): Promise<void> => {
        deregisterSignalHandlers();
        this.shutdown();
        await sleep(this.options.shutdownGraceTimeMs);
        if (!subscriber.closed) {
          subscriber.error(new Error('Timed out waiting while waiting for worker to shutdown gracefully'));
        }
      };
      const deregisterSignalHandlers = () => {
        for (const signal of this.options.shutdownSignals) {
          process.off(signal, startShutdownSequence);
        }
      };
      for (const signal of this.options.shutdownSignals) {
        process.once(signal, startShutdownSequence);
      }

      this.state = 'RUNNING';

      workerPoll(this.nativeWorker, queueName, (err, buffer) => {
        if (err && err.message.includes('[Core::shutdown]')) {
          subscriber.complete();
        } else if (buffer === undefined) {
          subscriber.error(err);
        } else {
          const task = coresdk.Task.decode(new Uint8Array(buffer));
          subscriber.next(task);
        }
      });

      return function unsubscribe() {
        // NOTE: We don't expose this observable directly so we don't have to shutdown here
        deregisterSignalHandlers();
      };
    });
  }

  activityOperator(): OperatorFunction<TaskForActivity, Uint8Array> {
    return pipe(
      groupBy((task) => task.activity.activityId),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(async (activity: Activity | undefined, task) => {
            // We either want to return an activity result or pass on the activity for running at a later stage
            // We don't run the activity directly in this operator because we need to return the activity in the state
            // so it can be cancelled if requested
            let output: { type: 'result'; result: coresdk.IActivityResult } | { type: 'run'; activity: Activity };
            const { taskToken } = task;
            const { job } = task.activity;
            if (!job) {
              throw new Error('Got an activity task without a "job" attribute');
            }

            switch (job) {
              case 'start': {
                const { start } = task.activity;
                if (!start) {
                  throw new Error('Got a "start" activity task without a "start" attribute');
                }
                if (!start.activityType?.name) {
                  throw new Error('Got a StartActivity.activityType without a "name" attribute');
                }
                const [path, fnName] = JSON.parse(start.activityType.name);
                const module = this.resolvedActivities.get(path);
                if (module === undefined) {
                  output = {
                    type: 'result',
                    result: { failed: { failure: { message: `Activity module found: ${path}` } } },
                  };
                  break;
                }
                const fn = module[fnName];
                if (!(fn instanceof Function)) {
                  output = {
                    type: 'result',
                    result: { failed: { failure: { message: `Activity function ${fnName} not found in: ${path}` } } },
                  };
                  break;
                }
                const args = arrayFromPayloads(this.options.dataConverter, start.input);
                activity = new Activity(fn, args);
                output = { type: 'run', activity };
                break;
              }
              case 'cancel': {
                if (activity === undefined) {
                  output = { type: 'result', result: { failed: { failure: { message: 'Activity not found' } } } };
                  break;
                }
                await activity.cancel();
                output = {
                  type: 'result',
                  result: {
                    canceled: {},
                  },
                };
                break;
              }
            }
            return { state: activity, output: { taskToken, output } };
          }, undefined),
          mergeMap(async ({ output, taskToken }) => {
            if (output.type === 'result') {
              return { taskToken, result: output.result };
            }

            try {
              const result = output.activity.run();
              return { taskToken, result: { completed: { result: this.options.dataConverter.toPayloads(result) } } };
            } catch (error) {
              return { taskToken, result: { failed: { failure: { message: error.message /* TODO: stackTrace */ } } } };
            }
          }),
          map(({ taskToken, result }) =>
            coresdk.TaskCompletion.encodeDelimited({
              taskToken: taskToken,
              activity: result,
            }).finish()
          )
        );
      })
    );
  }

  workflowOperator(): OperatorFunction<TaskForWorkflow, Uint8Array> {
    return pipe(
      groupBy((task) => task.workflow.runId),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(async (workflow: Workflow | undefined, task) => {
            if (workflow === undefined) {
              try {
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
                  await workflow.registerActivities(this.resolvedActivities);
                  const scriptName = await resolver(
                    this.options.workflowsPath,
                    this.workflowOverrides
                  )(attrs.workflowType);
                  await workflow.registerImplementation(scriptName);
                } else {
                  throw new Error('Received workflow activation for an untracked workflow with no start workflow job');
                }
              } catch (err) {
                let arr: Uint8Array;
                if (err instanceof LoaderError) {
                  arr = coresdk.TaskCompletion.encodeDelimited({
                    taskToken: task.taskToken,
                    workflow: {
                      successful: {
                        commands: [
                          {
                            api: {
                              commandType: temporal.api.enums.v1.CommandType.COMMAND_TYPE_FAIL_WORKFLOW_EXECUTION,
                              failWorkflowExecutionCommandAttributes: {
                                failure: { message: err.message /* TODO: stack trace */ },
                              },
                            },
                          },
                        ],
                      },
                    },
                  }).finish();
                } else {
                  const cause = temporal.api.enums.v1.WorkflowTaskFailedCause.WORKFLOW_TASK_FAILED_CAUSE_UNSPECIFIED;
                  arr = coresdk.TaskCompletion.encodeDelimited({
                    taskToken: task.taskToken,
                    workflow: {
                      failed: {
                        cause,
                        failure: { message: err.message /* TODO: stack trace */ },
                      },
                    },
                  }).finish();
                }
                workflow?.isolate.dispose();
                return { state: undefined, output: arr };
              }
            }

            const arr = await workflow.activate(task.taskToken, task.workflow);
            return { state: workflow, output: arr };
          }, undefined)
        );
      })
    );
  }

  async run(queueName: string): Promise<void> {
    const partitioned$ = partition(
      this.poller$(queueName).pipe(
        tap(
          () => undefined,
          () => {
            this.state = 'FAILED';
          },
          () => {
            this.state = 'STOPPED';
          }
        ),
        share()
      ),
      (task) => task.variant === 'workflow'
    );
    // Need to cast to any in order to assign the correct types a partition returns an Observable<Task>
    const [workflow$, activity$] = (partitioned$ as any) as [Observable<TaskForWorkflow>, Observable<TaskForActivity>];

    return await merge(workflow$.pipe(this.workflowOperator()), activity$.pipe(this.activityOperator()))
      .pipe(map((arr) => workerCompleteTask(this.nativeWorker, arr.buffer.slice(arr.byteOffset))))
      .toPromise();
  }
}
