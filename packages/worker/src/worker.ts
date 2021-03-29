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

export { RetryOptions, RemoteActivityOptions, LocalActivityOptions } from '@temporalio/workflow';
export { ActivityOptions, DataConverter };

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
   * @default `@temporal/worker` package name and version
   */
  workerBinaryId?: string;
  /**
   * Timeout for long polls (polling of task queues)
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
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
   * pass `null` to manually register activities.
   * @default ../activities
   */
  activitiesPath?: string | null;

  /**
   * Path to look up workflows in.
   * pass `null` to manually register workflows
   * @default ../workflows
   */
  workflowsPath?: string | null;

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  shutdownGraceTime?: string;

  /**
   * Automatically shut down worker on any of these signals.
   * @default ```ts
   * ['SIGINT', 'SIGTERM', 'SIGQUIT']
   * ```
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
      | 'activitiesPath'
      | 'workflowsPath'
      | 'shutdownGraceTime'
      | 'shutdownSignals'
      | 'dataConverter'
      | 'logger'
      | 'activityDefaults'
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
    activityDefaults: { type: 'remote', scheduleToCloseTimeout: '10m' },
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
  pollWorkflowActivation(queueName: string): Promise<ArrayBuffer>;
  completeWorkflowActivation: OmitFirstParam<typeof native.workerCompleteWorkflowActivation>;
  sendActivityHeartbeat: OmitFirstParam<typeof native.workerSendActivityHeartbeat>;
}

export interface WorkerConstructor {
  new (options?: ServerOptions): NativeWorkerLike;
}

export class NativeWorker implements NativeWorkerLike {
  protected readonly native: native.Worker;
  protected readonly pollFn: (worker: native.Worker, queueName: string) => Promise<ArrayBuffer>;

  public constructor(options?: ServerOptions) {
    const compiledOptions = compileServerOptions({ ...getDefaultServerOptions(), ...options });
    this.native = native.newWorker(compiledOptions);
    this.pollFn = promisify(native.workerPollWorkflowActivation);
  }

  public shutdown(): void {
    return native.workerShutdown(this.native);
  }

  public pollWorkflowActivation(queueName: string): Promise<ArrayBuffer> {
    return this.pollFn(this.native, queueName);
  }

  public completeWorkflowActivation(result: ArrayBuffer): void {
    return native.workerCompleteWorkflowActivation(this.native, result);
  }

  public sendActivityHeartbeat(activityId: string, details?: ArrayBuffer): void {
    return native.workerSendActivityHeartbeat(this.native, activityId, details);
  }
}

/**
 * Temporal Worker, connects to the Temporal server and runs workflows and activities
 */
export class Worker {
  public readonly options: CompiledWorkerOptionsWithDefaults;
  protected readonly workflowOverrides: Map<string, string> = new Map();
  protected readonly resolvedActivities: Map<string, Record<string, () => any>>;
  protected readonly activityHeartbeatSubject = new Subject<{
    activityId: string;
    details?: any;
  }>();
  protected readonly pollSubject = new Subject<coresdk.workflow_activation.WFActivation>();
  protected stateSubject: BehaviorSubject<State> = new BehaviorSubject<State>('INITIALIZED');
  protected readonly nativeWorker: NativeWorkerLike;

  protected static nativeWorkerCtor: WorkerConstructor = NativeWorker;

  /**
   * Create a new Worker.
   * This method immediately connects to the server and will throw on connection failure.
   * @param pwd - Used to resolve relative paths for locating and importing activities and workflows.
   */
  constructor(public readonly pwd: string, options?: WorkerOptions) {
    // Typescript derives the type of `this.constructor` as Function, work around it by casting to any
    const nativeWorkerCtor: WorkerConstructor = (this.constructor as any).nativeWorkerCtor;
    this.nativeWorker = new nativeWorkerCtor(options?.serverOptions);

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
          this.log.debug('Loaded activity', { importName, fullPath });
          this.resolvedActivities.set(`@activities/${importName}`, functions);
          if (importName === 'index') {
            this.resolvedActivities.set('@activities', functions);
          }
        }
      }
    }
  }

  protected get log(): Logger {
    return this.options.logger;
  }

  /**
   * Get the poll state of this worker
   */
  public getState(): State {
    // Setters and getters require the same visibility, add this public getter function
    return this.stateSubject.getValue();
  }

  protected get state(): State {
    return this.stateSubject.getValue();
  }

  protected set state(state: State) {
    this.log.info('Worker state changed', { state });
    this.stateSubject.next(state);
  }

  /**
   * Manually register workflows, e.g. for when using a non-standard directory structure.
   */
  public async registerWorkflows(nameToPath: Record<string, string>): Promise<void> {
    for (const [name, path] of Object.entries(nameToPath)) {
      this.log.info('Registering workflow override', { name, path });
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
      this.log.info('Registering activities', { name, functions: Object.keys(functions) });
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
  protected pollLoop$(queueName: string): Observable<coresdk.workflow_activation.WFActivation> {
    return of(this.stateSubject).pipe(
      map((state) => state.getValue()),
      concatMap((state) => {
        switch (state) {
          case 'RUNNING':
          case 'STOPPING':
            return this.nativeWorker.pollWorkflowActivation(queueName);
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
      map((buffer) => coresdk.workflow_activation.WFActivation.decode(new Uint8Array(buffer)))
    );
  }

  /**
   * The main observable of the worker, starts the poll loop and takes care of state transitions
   * in case of an error during poll or shutdown
   */
  protected poller$(queueName: string): Observable<coresdk.workflow_activation.WFActivation> {
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
                this.log.debug('Starting activity', { activityId, path, fnName });
                activity = new Activity(activityId, fn, args, this.options.dataConverter, (details) =>
                  this.activityHeartbeatSubject.next({
                    activityId,
                    details,
                  })
                );
                output = { type: 'run', activity };
                break;
              }
              case 'cancel': {
                const { activityId } = task.activity;
                if (activity === undefined) {
                  this.log.error('Tried to cancel a non-existing activity', { activityId });
                  output = { type: 'result', result: { failed: { failure: { message: 'Activity not found' } } } };
                  break;
                }
                this.log.debug('Cancelling activity', { activityId });
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
            const status = result.failed ? 'failed' : result.completed ? 'completed' : 'cancelled';
            this.log.debug('Activity resolved', { activityId: output.activity.id, status });
            if (result.canceled) {
              return undefined; // Cancelled emitted on cancellation request, ignored in activity run result
            }
            return { taskToken, result };
          }),
          filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
          map(({ taskToken, result }) =>
            // TODO: taskToken: taskToken,
            coresdk.activity_result.ActivityResult.encodeDelimited(result).finish()
          ),
          tap(group$.close)
        );
      })
    );
  }

  /**
   * Process workflow activations
   * @param queueName used to propagate the current task queue to the workflow
   */
  protected workflowOperator(
    queueName: string
  ): OperatorFunction<coresdk.workflow_activation.WFActivation, Uint8Array> {
    return pipe(
      closeableGroupBy((task) => task.runId),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(async (workflow: Workflow | undefined, task) => {
            const taskToken = Buffer.from(task.taskToken).toString('hex');
            if (workflow === undefined) {
              try {
                // Find a workflow start job in the activation jobs list
                // TODO: should this always be the first job in the list?
                const maybeStartWorkflow = task.jobs.find((j) => j.startWorkflow);
                if (maybeStartWorkflow !== undefined) {
                  const attrs = maybeStartWorkflow.startWorkflow;
                  if (!(attrs && attrs.workflowId && attrs.workflowType)) {
                    throw new Error(
                      `Expected StartWorkflow with workflowId and workflowType, got ${JSON.stringify(
                        maybeStartWorkflow
                      )}`
                    );
                  }
                  this.log.debug('Creating workflow', {
                    taskToken,
                    workflowId: attrs.workflowId,
                    runId: task.runId,
                  });
                  workflow = await Workflow.create(attrs.workflowId, queueName);
                  // TODO: this probably shouldn't be here, consider alternative implementation
                  await workflow.inject('console.log', console.log);
                  await workflow.registerActivities(this.resolvedActivities, this.options.activityDefaults);
                  const scriptName = await resolver(
                    this.options.workflowsPath,
                    this.workflowOverrides
                  )(attrs.workflowType);
                  await workflow.registerImplementation(scriptName);
                } else {
                  throw new Error('Received workflow activation for an untracked workflow with no start workflow job');
                }
              } catch (error) {
                this.log.error('Failed to create a workflow', { taskToken, runId: task.runId, error });
                let arr: Uint8Array;
                if (error instanceof LoaderError) {
                  arr = coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
                    taskToken: task.taskToken,
                    successful: {
                      commands: [{ failWorkflowExecution: { failure: errorToUserCodeFailure(error) } }],
                    },
                  }).finish();
                } else {
                  arr = coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
                    taskToken: task.taskToken,
                    failed: {
                      failure: errorToUserCodeFailure(error),
                    },
                  }).finish();
                }
                workflow?.isolate.dispose();
                return { state: undefined, output: { close: true, arr } };
              }
            }

            this.log.debug('Activating workflow', { taskToken });
            // TODO: single param
            const arr = await workflow.activate(task.taskToken, task);
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
      takeUntil(this.stateSubject.pipe(filter((value) => value === 'STOPPED' || value === 'FAILED'))),
      tap(({ activityId }) => this.log.debug('Got activity heartbeat', { activityId })),
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
      })
    );
  }

  /**
   * Start polling on tasks, completes after graceful shutdown after a receiving a shutdown signal
   * or call to {@link shutdown}.
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
    const workflow$ = this.poller$(queueName).pipe(tap((task) => this.log.debug('Got task', task)));

    // const partitioned$ = partition(
    //   this.poller$(queueName).pipe(
    //     share(),
    //     tap((task) => this.log.debug('Got task', task))
    //   ),
    //   (task) => task.variant === 'workflow'
    // );
    // // Need to cast to any in order to assign the specific types since partition returns an Observable<Task>
    // const [workflow$, activity$] = (partitioned$ as any) as [Observable<TaskForWorkflow>, Observable<TaskForActivity>];
    // , activity$.pipe(this.activityOperator())
    return await merge(
      this.activityHeartbeat$(),
      merge(workflow$.pipe(this.workflowOperator(queueName))).pipe(
        map((arr) => this.nativeWorker.completeWorkflowActivation(arr.buffer.slice(arr.byteOffset)))
      )
    ).toPromise();
  }
}
