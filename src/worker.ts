import { resolve } from 'path';
import { Observable } from 'rxjs';
import { groupBy, mergeMap, mergeScan } from 'rxjs/operators';
import { newWorker, workerPoll, PollResult } from '../native';
import { Workflow } from './engine';
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
  public async suspendPolling(): Promise<void> {
  }

  /**
   * Allow new poll requests.
   */
  public resumePolling(): void {
  }

  public isSuspended(): boolean {
    return false;
  }

  async run(queueName: string) {
    const native = newWorker(queueName);
    await new Observable<PollResult>((subscriber) => {
      workerPoll(native, (err, result) => {
        // TODO: this shouldn't happen in the non-mocked version
        if (err && err.message === 'No tasks to perform for now') {
          subscriber.complete();
          return;
        }
        if (result === undefined) {
          subscriber.error(err);
          return;
        }
        subscriber.next(result);
        return () => {}; // TODO: shutdown worker if no subscribers
      });
    })
      .pipe(
        groupBy(({ workflowID }) => workflowID),
        mergeMap((group$) => {
          return group$.pipe(
            mergeScan(async (workflow: Workflow | undefined, task) => {
              if (workflow === undefined) {
                workflow = await Workflow.create(group$.key);
                await workflow.inject('console.log', console.log);
              }
              console.log(task);
              switch (task.type) {
                case 'StartWorkflow': {
                  // TODO: get script name from task params
                  const scriptName = process.argv[process.argv.length - 1];
                  const commands = await workflow.runMain(scriptName);
                  console.log(commands[0]);
                  break;
                }
                case 'TriggerTimer': {
                  const commands = await workflow.trigger(task);
                  console.log(commands[0]);
                  break;
                }
                default:
                  // ignore
              }
              return workflow;
            }, undefined, 1 /* concurrency */))
        })
      )
      .toPromise();
  }
}
