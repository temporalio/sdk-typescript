import { basename, extname, resolve } from 'path';
import os from 'os';
import { readdirSync } from 'fs';
import { promisify } from 'util';
import {
  BehaviorSubject,
  merge,
  Observable,
  OperatorFunction,
  Subject,
  partition,
  pipe,
  EMPTY,
  throwError,
  of,
} from 'rxjs';
import {
  catchError,
  concatMap,
  delay,
  filter,
  first,
  ignoreElements,
  map,
  mergeMap,
  repeat,
  share,
  takeUntil,
  tap,
} from 'rxjs/operators';
import ms from 'ms';
import { coresdk } from '@temporalio/proto';
import { ActivityOptions } from '@temporalio/workflow';
import { errorToUserCodeFailure } from '@temporalio/workflow/commonjs/common';
import {
  DataConverter,
  defaultDataConverter,
  arrayFromPayloads,
} from '@temporalio/workflow/commonjs/converter/data-converter';
import * as native from '../native';
import { mergeMapWithState, closeableGroupBy } from './rxutils';
import { resolveFilename, LoaderError } from './loader';
import { Workflow } from './workflow';
import { Activity } from './activity';
import { Logger, DefaultLogger } from './logger';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

export interface ServerOptions {
  /**
   * The URL of the Temporal server to connect to
   * @default http://localhost:7233
   */
  url?: string;
  /**
   * What namespace will we operate under
   * @default default
   */
  namespace?: string;

  /**
   * A human-readable string that can identify your worker
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;
  /**
   * A string that should be unique to the exact worker code/binary being executed
   * @default to the @temporal/worker package version
   */
  workerBinaryId?: string;
  /**
   * Timeout for long polls (polling of task queues)
   * @format ms formatted string
   */
  longPollTimeout?: string;
}

export type CompiledServerOptions = Omit<Required<ServerOptions>, 'longPollTimeout'> & {
  longPollTimeoutMs: number;
};

export interface WorkerOptions {
  /**
   * Options for communicating with the Tempral server
   */
  serverOptions?: ServerOptions;

  /**
   * Custom logger for the worker, by default we log everything to stderr
   */
  logger?: Logger;

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
    Pick<
      WorkerOptions,
      'activitiesPath' | 'workflowsPath' | 'shutdownGraceTime' | 'shutdownSignals' | 'dataConverter' | 'logger'
    >
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

export function getDefaultServerOptions(): Required<ServerOptions> {
  return {
    url: 'http://localhost:7233',
    identity: `${process.pid}@${os.hostname()}`,
    namespace: 'default',
    workerBinaryId: `${pkg.name}@${pkg.version}`,
    longPollTimeout: '30s',
  };
}

export function compileServerOptions(options: Required<ServerOptions>): native.ServerOptions {
  const { longPollTimeout, ...rest } = options;
  return { ...rest, longPollTimeoutMs: ms(longPollTimeout) };
}

export function getDefaultOptions(dirname: string): WorkerOptionsWithDefaults {
  return {
    activitiesPath: resolve(dirname, '../activities'),
    workflowsPath: resolve(dirname, '../workflows'),
    shutdownGraceTime: '5s',
    shutdownSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT'],
    dataConverter: defaultDataConverter,
    logger: new DefaultLogger(),
  };
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptionsWithDefaults {
  return { ...opts, shutdownGraceTimeMs: ms(opts.shutdownGraceTime) };
}

export type State = 'INITIALIZED' | 'RUNNING' | 'STOPPED' | 'STOPPING' | 'FAILED' | 'SUSPENDED';

type TaskForWorkflow = Required<{ taskToken: Uint8Array; workflow: coresdk.workflow_activation.WFActivation }>;
type TaskForActivity = Required<{ taskToken: Uint8Array; activity: coresdk.activity_task.ActivityTask }>;

type OmitFirst<T> = T extends [any, ...infer REST] ? REST : never;
type RestParams<T> = T extends (...args: any[]) => any ? OmitFirst<Parameters<T>> : never;
type OmitFirstParam<T> = T extends (...args: any[]) => any ? (...args: RestParams<T>) => ReturnType<T> : never;

export interface NativeWorkerLike {
  shutdown: OmitFirstParam<typeof native.workerShutdown>;
  poll(queueName: string): Promise<ArrayBuffer>;
  completeTask: OmitFirstParam<typeof native.workerCompleteTask>;
  sendActivityHeartbeat: OmitFirstParam<typeof native.workerSendActivityHeartbeat>;
}

export interface WorkerConstructor {
  new (...args: Parameters<typeof native.newWorker>): NativeWorkerLike;
}

export class NativeWorker implements NativeWorkerLike {
  protected readonly native: native.Worker;
  protected readonly pollFn: (worker: native.Worker, queueName: string) => Promise<ArrayBuffer>;

  public constructor(options?: ServerOptions) {
    const compiledOptions = compileServerOptions({ ...getDefaultServerOptions(), ...options });
    this.native = native.newWorker(compiledOptions);
    this.pollFn = promisify(native.workerPoll);
  }

  public shutdown(): void {
    return native.workerShutdown(this.native);
  }

  public poll(queueName: string): Promise<ArrayBuffer> {
    return this.pollFn(this.native, queueName);
  }

  public completeTask(result: ArrayBuffer): void {
    return native.workerCompleteTask(this.native, result);
  }

  public sendActivityHeartbeat(activityId: string, details?: ArrayBuffer): void {
    return native.workerSendActivityHeartbeat(this.native, activityId, details);
  }
}

/**
 * Base worker class - allows injection of native worker implementation for testing
 */
class BaseWorker {
  public readonly options: CompiledWorkerOptionsWithDefaults;
  protected readonly workflowOverrides: Map<string, string> = new Map();
  protected readonly resolvedActivities: Map<string, Record<string, () => any>>;
  protected readonly activityHeartbeatSubject = new Subject<{
    activityId: string;
    details?: any;
  }>();
  protected readonly pollSubject = new Subject<coresdk.Task>();
  protected stateSubject: BehaviorSubject<State> = new BehaviorSubject<State>('INITIALIZED');

  constructor(protected readonly nativeWorker: NativeWorkerLike, public readonly pwd: string, options?: WorkerOptions) {
    // TODO: merge activityDefaults
    this.options = compileWorkerOptions({ ...getDefaultOptions(pwd), ...options });
    this.resolvedActivities = new Map();
    if (this.options.activitiesPath !== null) {
      const files = readdirSync(this.options.activitiesPath, { encoding: 'utf8' });
      for (const file of files) {
        const ext = extname(file);
        if (ext === '.js') {
          const fullPath = resolve(this.options.activitiesPath, file);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const module = require(fullPath);
          const functions = Object.fromEntries(
            Object.entries(module).filter((entry): entry is [string, () => any] => entry[1] instanceof Function)
          );
          const importName = basename(file, ext);
          this.options.logger.debug('Loaded activity', { importName, fullPath });
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
    return this.stateSubject.getValue();
  }

  get state(): State {
    return this.stateSubject.getValue();
  }

  set state(state: State) {
    this.options.logger.debug('Worker state changed', { state });
    this.stateSubject.next(state);
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
   * Do not make new poll requests, current poll request is not cancelled and may complete.
   */
  public suspendPolling(): void {
    if (this.state !== 'RUNNING') {
      throw new Error('Not running');
    }
    this.state = 'SUSPENDED';
  }

  /**
   * Allow new poll requests.
   */
  public resumePolling(): void {
    if (this.state !== 'SUSPENDED') {
      throw new Error('Not suspended');
    }
    this.state = 'RUNNING';
  }

  public isSuspended(): boolean {
    return this.state === 'SUSPENDED';
  }

  shutdown(): void {
    if (this.state !== 'RUNNING' && this.state !== 'SUSPENDED') {
      throw new Error('Not running and not suspended');
    }
    this.state = 'STOPPING';
    this.nativeWorker.shutdown();
  }

  /**
   * An observable which is triggered when state becomes STOPPING and emits an error
   * after `this.options.shutdownGraceTimeMs`.
   */
  protected gracefulShutdown$(): Observable<never> {
    return this.stateSubject.pipe(
      filter((state): state is 'STOPPING' => state === 'STOPPING'),
      delay(this.options.shutdownGraceTimeMs),
      map(() => {
        throw new Error('Timed out waiting while waiting for worker to shutdown gracefully');
      })
    );
  }

  /**
   * An observable which repeatedly polls for new tasks unless worker becomes suspended
   */
  protected pollLoop$(queueName: string): Observable<coresdk.Task> {
    return of(this.stateSubject).pipe(
      map((state) => state.getValue()),
      concatMap((state) => {
        switch (state) {
          case 'RUNNING':
          case 'STOPPING':
            return this.nativeWorker.poll(queueName);
          case 'SUSPENDED':
            // Completes once we're out of SUSPENDED state
            return this.stateSubject.pipe(
              filter((st) => st !== 'SUSPENDED'),
              first(),
              ignoreElements()
            );
          default:
            // transition to STOPPED | FAILED happens only when an error occurs
            // in which case this observable would be closed
            throw new Error(`Unexpected state ${state}`);
        }
      }),
      repeat(),
      map((buffer) => coresdk.Task.decode(new Uint8Array(buffer)))
    );
  }

  /**
   * The main observable of the worker, starts the poll loop and takes care of state transitions
   * in case of an error during poll or shutdown
   */
  protected poller$(queueName: string): Observable<coresdk.Task> {
    return merge(this.gracefulShutdown$(), this.pollLoop$(queueName)).pipe(
      catchError((err) => (err.message.includes('[Core::shutdown]') ? EMPTY : throwError(err))),
      tap({
        complete: () => {
          this.state = 'STOPPED';
        },
        error: () => {
          this.state = 'FAILED';
        },
      })
    );
  }

  /**
   * Process activity tasks
   */
  protected activityOperator(): OperatorFunction<TaskForActivity, Uint8Array> {
    return pipe(
      closeableGroupBy((task) => task.activity.activityId),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(async (activity: Activity | undefined, task) => {
            // We either want to return an activity result or pass on the activity for running at a later stage
            // We don't run the activity directly in this operator because we need to return the activity in the state
            // so it can be cancelled if requested
            let output:
              | { type: 'result'; result: coresdk.activity_result.IActivityResult }
              | { type: 'run'; activity: Activity };
            const { taskToken } = task;
            const { variant } = task.activity;
            if (!variant) {
              throw new Error('Got an activity task without a "variant" attribute');
            }

            switch (variant) {
              case 'start': {
                const { start, activityId } = task.activity;
                if (!start) {
                  throw new Error('Got a "start" activity task without a "start" attribute');
                }
                if (!start.activityType) {
                  throw new Error('Got a StartActivity without an "activityType" attribute');
                }
                const [path, fnName] = JSON.parse(start.activityType);
                const module = this.resolvedActivities.get(path);
                if (module === undefined) {
                  output = {
                    type: 'result',
                    result: { failed: { failure: { message: `Activity module not found: ${path}` } } },
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
                activity = new Activity(fn, args, this.options.dataConverter, (details) =>
                  this.activityHeartbeatSubject.next({
                    activityId,
                    details,
                  })
                );
                output = { type: 'run', activity };
                break;
              }
              case 'cancel': {
                if (activity === undefined) {
                  output = { type: 'result', result: { failed: { failure: { message: 'Activity not found' } } } };
                  break;
                }
                activity.cancel();
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
            const result = await output.activity.run();
            if (result.canceled) {
              return undefined; // Cancelled emitted on cancellation request, ignored in activity run result
            }
            return { taskToken, result };
          }),
          filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
          map(({ taskToken, result }) =>
            coresdk.TaskCompletion.encodeDelimited({
              taskToken: taskToken,
              activity: result,
            }).finish()
          ),
          tap(group$.close)
        );
      })
    );
  }

  /**
   * Process workflow activations
   */
  protected workflowOperator(): OperatorFunction<TaskForWorkflow, Uint8Array> {
    return pipe(
      closeableGroupBy((task) => task.workflow.runId),
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
                        commands: [{ failWorkflowExecution: { failure: errorToUserCodeFailure(err) } }],
                      },
                    },
                  }).finish();
                } else {
                  arr = coresdk.TaskCompletion.encodeDelimited({
                    taskToken: task.taskToken,
                    workflow: {
                      failed: {
                        failure: errorToUserCodeFailure(err),
                      },
                    },
                  }).finish();
                }
                workflow?.isolate.dispose();
                return { state: undefined, output: { close: true, arr } };
              }
            }

            const arr = await workflow.activate(task.taskToken, task.workflow);
            return { state: workflow, output: { close: false, arr } };
          }, undefined),
          tap(({ close }) => void close && group$.close())
        );
      }),
      map(({ arr }) => arr)
    );
  }

  /**
   * Listen on heartbeats emitted from activities and send them to core
   */
  protected activityHeartbeat$(): Observable<void> {
    return this.activityHeartbeatSubject.pipe(
      map(({ activityId, details }) => {
        const payload = this.options.dataConverter.toPayload(details);
        if (!payload) {
          this.nativeWorker.sendActivityHeartbeat(activityId);
          return;
        }

        const arr = coresdk.common.Payload.encode(payload).finish();
        this.nativeWorker.sendActivityHeartbeat(
          activityId,
          arr.buffer.slice(arr.byteOffset, arr.byteLength + arr.byteOffset)
        );
      }),
      takeUntil(this.stateSubject.pipe(filter((value) => value === 'STOPPED' || value === 'FAILED')))
    );
  }

  /**
   * Start polling on tasks, completes after graceful shutdown after a receiving a shutdown signal
   * or call to @link{shutdown}.
   */
  async run(queueName: string): Promise<void> {
    if (this.state !== 'INITIALIZED') {
      throw new Error('Poller was aleady started');
    }
    this.state = 'RUNNING';

    const startShutdownSequence = () => {
      for (const signal of this.options.shutdownSignals) {
        process.off(signal, startShutdownSequence);
      }
      this.shutdown();
    };
    for (const signal of this.options.shutdownSignals) {
      process.on(signal, startShutdownSequence);
    }

    const partitioned$ = partition(this.poller$(queueName).pipe(share()), (task) => task.variant === 'workflow');
    // Need to cast to any in order to assign the specific types since partition returns an Observable<Task>
    const [workflow$, activity$] = (partitioned$ as any) as [Observable<TaskForWorkflow>, Observable<TaskForActivity>];

    return await merge(
      this.activityHeartbeat$(),
      merge(workflow$.pipe(this.workflowOperator()), activity$.pipe(this.activityOperator())).pipe(
        map((arr) => this.nativeWorker.completeTask(arr.buffer.slice(arr.byteOffset)))
      )
    ).toPromise();
  }
}

export class Worker extends BaseWorker {
  /**
   * Create a new Worker.
   * This method immediately connects to the server and will throw on connection failure.
   * @param pwd - Used to resolve relative paths for locating and importing activities and workflows.
   */
  constructor(public readonly pwd: string, options?: WorkerOptions) {
    super(new NativeWorker(options?.serverOptions), pwd, options);
  }
}

export const testing = { BaseWorker };
