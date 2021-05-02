import { basename, extname, resolve } from 'path';
import os from 'os';
import { readdirSync } from 'fs';
import { promisify } from 'util';
import {
  BehaviorSubject,
  EMPTY,
  merge,
  MonoTypeOperatorFunction,
  Observable,
  of,
  OperatorFunction,
  pipe,
  race,
  Subject,
  throwError,
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
  takeUntil,
  tap,
  scan,
} from 'rxjs/operators';
import ms from 'ms';
import { coresdk } from '@temporalio/proto';
import { ActivityOptions } from '@temporalio/workflow';
import { Info as ActivityInfo } from '@temporalio/activity';
import { errorToUserCodeFailure } from '@temporalio/workflow/commonjs/common';
import { tsToMs } from '@temporalio/workflow/commonjs/time';
import { IllegalStateError } from '@temporalio/workflow/commonjs/errors';
import {
  arrayFromPayloads,
  DataConverter,
  defaultDataConverter,
} from '@temporalio/workflow/commonjs/converter/data-converter';
import * as native from '../native';
import { closeableGroupBy, mergeMapWithState } from './rxutils';
import { LoaderError, resolveFilename } from './loader';
import { Workflow } from './workflow';
import { Activity } from './activity';
import { DefaultLogger, Logger } from './logger';
import * as errors from './errors';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

export { RetryOptions, RemoteActivityOptions, LocalActivityOptions } from '@temporalio/workflow';
export { ActivityOptions, DataConverter, errors };

native.registerErrors(errors);

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
   * Options for communicating with the Temporal server
   */
  serverOptions?: ServerOptions;

  /**
   * The task queue the worker will pull from
   */
  taskQueue: string;

  /**
   * Custom logger for the worker, by default we log everything to stderr
   */
  logger?: Logger;

  /**
   * Activities created in workflows will default to having these options
   *
   * @default
   * ```ts
   * { type: 'remote', startToCloseTimeout: '10m' }
   * ```
   */
  activityDefaults?: ActivityOptions;

  /**
   * If provided, automatically discover Workflows and Activities relative to path.
   *
   * @see {@link activitiesPath} and {@link workflowsPath}
   */
  workDir?: string;

  /**
   * Path to look up activities in.
   * Automatically discovered if {@link workDir} is provided.
   * @default ${workDir}/../activities
   */
  activitiesPath?: string;

  /**
   * Path to look up workflows in.
   * Automatically discovered if {@link workDir} is provided.
   * @default ${workDir}/../workflows
   */
  workflowsPath?: string;

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  shutdownGraceTime?: string;

  /**
   * Automatically shut down worker on any of these signals.
   * @default
   * ```ts
   * ['SIGINT', 'SIGTERM', 'SIGQUIT']
   * ```
   */
  shutdownSignals?: NodeJS.Signals[];

  /**
   * TODO: document, figure out how to propagate this to the workflow isolate
   */
  dataConverter?: DataConverter;

  /**
   * Maximum number of Activities to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 200
   */
  maxConcurrentActivityExecutions?: number;
  /**
   * Maximum number of Workflow tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 200
   */
  maxConcurrentWorkflowTaskExecutions?: number;

  // TODO: implement all of these
  maxConcurrentLocalActivityExecutions?: number; // defaults to 200
  maxTaskQueueActivitiesPerSecond?: number;
  maxWorkerActivitiesPerSecond?: number;
  isLocalActivityWorkerOnly?: boolean; // defaults to false
}

export type WorkerOptionsWithDefaults = Omit<WorkerOptions, 'serverOptions'> & {
  serverOptions: Required<ServerOptions>;
} & Required<
    Pick<
      WorkerOptions,
      | 'shutdownGraceTime'
      | 'shutdownSignals'
      | 'dataConverter'
      | 'logger'
      | 'activityDefaults'
      | 'maxConcurrentActivityExecutions'
      | 'maxConcurrentWorkflowTaskExecutions'
    >
  >;

export interface CompiledWorkerOptionsWithDefaults extends Omit<WorkerOptionsWithDefaults, 'serverOptions'> {
  shutdownGraceTimeMs: number;
  serverOptions: CompiledServerOptions;
}

export const resolver = (baseDir: string | undefined, overrides: Map<string, string>) => async (
  lookupName: string
): Promise<string> => {
  const resolved = overrides.get(lookupName);
  if (resolved !== undefined) return resolved;
  if (baseDir === undefined) {
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

export function addDefaults(options: WorkerOptions): WorkerOptionsWithDefaults {
  const { serverOptions, workDir, ...rest } = options;
  return {
    activitiesPath: workDir ? resolve(workDir, '../activities') : undefined,
    workflowsPath: workDir ? resolve(workDir, '../workflows') : undefined,
    shutdownGraceTime: '5s',
    shutdownSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT'],
    dataConverter: defaultDataConverter,
    logger: new DefaultLogger(),
    activityDefaults: { type: 'remote', startToCloseTimeout: '10m' },
    serverOptions: { ...getDefaultServerOptions(), ...serverOptions },
    maxConcurrentActivityExecutions: 200,
    maxConcurrentWorkflowTaskExecutions: 200,
    ...rest,
  };
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptionsWithDefaults {
  return {
    ...opts,
    shutdownGraceTimeMs: ms(opts.shutdownGraceTime),
    serverOptions: compileServerOptions(opts.serverOptions),
  };
}

export function compileNativeWorkerOptions(
  opts: WorkerOptionsWithDefaults,
  serverOptions: Required<ServerOptions>
): native.WorkerOptions {
  return { ...opts, serverOptions: compileServerOptions(serverOptions) };
}

/**
 * The worker's possible states
 * * `INITIALIZED` - The initial state of the Worker after calling create() and successful connection to the server
 * * `RUNNING` - {@link Worker.run} was called, polling task queues
 * * `SUSPENDED` - {@link Worker.suspendPolling} was called, not polling for new tasks
 * * `STOPPING` - {@link Worker.shutdown} was called or received shutdown signal
 * * `DRAINING` - Core has indicated that shutdown is complete, allow activations and tasks to complete with respect to {@link WorkerOptions.shutdownGraceTime | shutdownGraceTime}
 * * `DRAINED` - Draining complete, completing shutdown
 * * `STOPPED` - Shutdown complete, {@link Worker.run} resolves
 * * `FAILED` - Worker encountered an unrecoverable error, {@link Worker.run} should reject with the error
 */
export type State =
  | 'INITIALIZED'
  | 'RUNNING'
  | 'STOPPED'
  | 'STOPPING'
  | 'DRAINING'
  | 'DRAINED'
  | 'FAILED'
  | 'SUSPENDED';

type ExtractToPromise<T> = T extends (err: any, result: infer R) => void ? Promise<R> : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Last<T extends any[]> = T extends [...infer I, infer L] ? L : never;
type LastParameter<F extends (...args: any) => any> = Last<Parameters<F>>;
type OmitFirst<T> = T extends [any, ...infer REST] ? REST : never;
type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
type OmitFirstParam<T> = T extends (...args: any[]) => any
  ? (...args: OmitFirst<Parameters<T>>) => ReturnType<T>
  : never;
type Promisify<T> = T extends (...args: any[]) => void
  ? (...args: OmitLast<Parameters<T>>) => ExtractToPromise<LastParameter<T>>
  : never;

export interface NativeWorkerLike {
  shutdown: Promisify<OmitFirstParam<typeof native.workerShutdown>>;
  breakLoop: Promisify<OmitFirstParam<typeof native.workerBreakLoop>>;
  pollWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerPollWorkflowActivation>>;
  pollActivityTask: Promisify<OmitFirstParam<typeof native.workerPollActivityTask>>;
  completeWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerCompleteWorkflowActivation>>;
  completeActivityTask: Promisify<OmitFirstParam<typeof native.workerCompleteActivityTask>>;
  recordActivityHeartbeat: Promisify<OmitFirstParam<typeof native.workerRecordActivityHeartbeat>>;
}

export interface WorkerConstructor {
  create(options: CompiledWorkerOptionsWithDefaults): Promise<NativeWorkerLike>;
}

export class NativeWorker implements NativeWorkerLike {
  public readonly pollWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerPollWorkflowActivation>>;
  public readonly pollActivityTask: Promisify<OmitFirstParam<typeof native.workerPollActivityTask>>;
  public readonly completeWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerCompleteWorkflowActivation>>;
  public readonly completeActivityTask: Promisify<OmitFirstParam<typeof native.workerCompleteActivityTask>>;
  public readonly recordActivityHeartbeat: Promisify<OmitFirstParam<typeof native.workerRecordActivityHeartbeat>>;
  public readonly breakLoop: Promisify<OmitFirstParam<typeof native.workerBreakLoop>>;
  public readonly shutdown: Promisify<OmitFirstParam<typeof native.workerShutdown>>;

  public static async create(options: CompiledWorkerOptionsWithDefaults): Promise<NativeWorkerLike> {
    const nativeWorker = await promisify(native.newWorker)(options);
    return new NativeWorker(nativeWorker);
  }

  protected constructor(nativeWorker: native.Worker) {
    this.pollWorkflowActivation = promisify(native.workerPollWorkflowActivation).bind(undefined, nativeWorker);
    this.pollActivityTask = promisify(native.workerPollActivityTask).bind(undefined, nativeWorker);
    this.completeWorkflowActivation = promisify(native.workerCompleteWorkflowActivation).bind(undefined, nativeWorker);
    this.completeActivityTask = promisify(native.workerCompleteActivityTask).bind(undefined, nativeWorker);
    this.recordActivityHeartbeat = promisify(native.workerRecordActivityHeartbeat).bind(undefined, nativeWorker);
    this.breakLoop = promisify(native.workerBreakLoop).bind(undefined, nativeWorker);
    this.shutdown = promisify(native.workerShutdown).bind(undefined, nativeWorker);
  }
}

function formatTaskToken(taskToken: Uint8Array) {
  return Buffer.from(taskToken.slice(0, 8)).toString('base64');
}

/**
 * The temporal worker connects to the service and runs workflows and activities.
 */
export class Worker {
  protected readonly workflowOverrides: Map<string, string> = new Map();
  protected readonly resolvedActivities: Map<string, Record<string, () => any>>;
  protected readonly activityHeartbeatSubject = new Subject<{
    taskToken: Uint8Array;
    details?: any;
  }>();
  protected readonly activityFeedbackSubject = new Subject<coresdk.activity_task.ActivityTask>();
  protected stateSubject: BehaviorSubject<State> = new BehaviorSubject<State>('INITIALIZED');
  protected readonly nativeWorker: NativeWorkerLike;

  protected static nativeWorkerCtor: WorkerConstructor = NativeWorker;

  /**
   * Create a new Worker.
   * This method initiates a connection to the server and will throw (asynchronously) on connection failure.
   */
  public static async create(options: WorkerOptions): Promise<Worker> {
    const nativeWorkerCtor: WorkerConstructor = this.nativeWorkerCtor;
    const compiledOptions = compileWorkerOptions(addDefaults(options));
    const nativeWorker = await nativeWorkerCtor.create(compiledOptions);
    return new this(nativeWorker, compiledOptions);
  }

  /**
   * Create a new Worker from nativeWorker.
   * @param pwd - Used to resolve relative paths for locating and importing activities and workflows.
   */
  protected constructor(nativeWorker: NativeWorkerLike, public readonly options: CompiledWorkerOptionsWithDefaults) {
    this.nativeWorker = nativeWorker;

    this.resolvedActivities = new Map();
    if (this.options.activitiesPath !== undefined) {
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
      throw new IllegalStateError('Not running');
    }
    this.state = 'SUSPENDED';
  }

  /**
   * Allow new poll requests.
   */
  public resumePolling(): void {
    if (this.state !== 'SUSPENDED') {
      throw new IllegalStateError('Not suspended');
    }
    this.state = 'RUNNING';
  }

  public isSuspended(): boolean {
    return this.state === 'SUSPENDED';
  }

  /**
   * Start shutting down the Worker.
   * Immediately transitions state to STOPPING and asks Core to shut down.
   * Once Core has confirmed that it's shutting down the Worker enters DRAINING state.
   * {@see State}.
   */
  shutdown(): void {
    if (this.state !== 'RUNNING' && this.state !== 'SUSPENDED') {
      throw new IllegalStateError('Not running and not suspended');
    }
    this.state = 'STOPPING';
    this.nativeWorker.shutdown().then(() => {
      this.state = 'DRAINING';
    });
  }

  /**
   * An observable which completes when state becomes DRAINED or throws if state transitions to STOPPING and remains that way for {@link this.options.shutdownGraceTimeMs}.
   */
  protected gracefulShutdown$(): Observable<never> {
    return race(
      this.stateSubject.pipe(
        filter((state): state is 'STOPPING' => state === 'STOPPING'),
        delay(this.options.shutdownGraceTimeMs),
        map(() => {
          throw new errors.GracefulShutdownPeriodExpiredError(
            'Timed out while waiting for worker to shutdown gracefully'
          );
        })
      ),
      this.stateSubject.pipe(
        filter((state) => state === 'DRAINED'),
        first()
      )
    ).pipe(ignoreElements());
  }

  /**
   * An observable which repeatedly polls for new tasks unless worker becomes suspended.
   * The observable stops emitting once core is shutting down.
   */
  protected pollLoop$<T>(pollFn: () => Promise<T>): Observable<T> {
    return of(this.stateSubject).pipe(
      map((state) => state.getValue()),
      concatMap((state) => {
        switch (state) {
          case 'RUNNING':
          case 'STOPPING':
            return pollFn();
          case 'SUSPENDED':
            // Completes once we're out of SUSPENDED state
            return this.stateSubject.pipe(
              filter((st) => st !== 'SUSPENDED'),
              first(),
              ignoreElements()
            );
          default:
            // transition to DRAINING | FAILED happens only when an error occurs
            // in which case this observable would be closed
            throw new IllegalStateError(`Unexpected state ${state}`);
        }
      }),
      repeat(),
      catchError((err) => (err instanceof errors.ShutdownError ? EMPTY : throwError(err)))
    );
  }

  /**
   * Process activity tasks
   */
  protected activityOperator(): OperatorFunction<coresdk.activity_task.ActivityTask, Uint8Array> {
    return pipe(
      closeableGroupBy((task) => task.taskToken.toString()),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(async (activity: Activity | undefined, task) => {
            // We either want to return an activity result or pass on the activity for running at a later stage
            // We don't run the activity directly in this operator because we need to return the activity in the state
            // so it can be cancelled if requested
            let output:
              | { type: 'result'; result: coresdk.activity_result.IActivityResult }
              | { type: 'run'; activity: Activity };
            const { taskToken, variant, activityId } = task;
            if (!variant) {
              throw new TypeError('Got an activity task without a "variant" attribute');
            }

            switch (variant) {
              case 'start': {
                const info = extractActivityInfo(
                  task,
                  false,
                  this.options.dataConverter,
                  this.options.serverOptions.namespace
                );
                const [path, fnName] = info.activityType;
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
                const args = arrayFromPayloads(this.options.dataConverter, task?.start?.input);
                this.log.debug('Starting activity', { activityId, path, fnName });

                activity = new Activity(info, fn, args, this.options.dataConverter, (details) =>
                  this.activityHeartbeatSubject.next({
                    taskToken,
                    details,
                  })
                );
                output = { type: 'run', activity };
                break;
              }
              case 'cancel': {
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
            this.log.debug('Activity resolved', { activityId: output.activity.info.activityId, status });
            if (result.canceled) {
              return undefined; // Cancelled emitted on cancellation request, ignored in activity run result
            }
            return { taskToken, result };
          }),
          filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
          map((result) => coresdk.ActivityTaskCompletion.encodeDelimited(result).finish()),
          tap(group$.close) // Close the group after activity task completion
        );
      })
    );
  }

  /**
   * Process workflow activations
   */
  protected workflowOperator(
    numInFlightActivationsSubject: BehaviorSubject<number>,
    numRunningWorkflowInstancesSubject: BehaviorSubject<number>
  ): OperatorFunction<coresdk.workflow_activation.WFActivation, Uint8Array> {
    return pipe(
      tap(() => {
        numInFlightActivationsSubject.next(numInFlightActivationsSubject.value + 1);
      }),
      closeableGroupBy((task) => task.runId),
      mergeMap((group$) => {
        return group$.pipe(
          // TODO: We close the Observable here but we should make sure to dispose of the isolate
          this.takeUntilIdle(numInFlightActivationsSubject),
          mergeMapWithState(async (workflow: Workflow | undefined, task): Promise<{
            state: Workflow | undefined;
            output: { arr?: Uint8Array; close: boolean };
          }> => {
            const taskToken = formatTaskToken(task.taskToken);
            const jobs = task.jobs.filter(({ removeFromCache }) => !removeFromCache);
            // Found a removeFromCache job
            const close = jobs.length < task.jobs.length;
            task.jobs = jobs;
            if (jobs.length === 0) {
              workflow?.isolate.dispose();
              if (!close) {
                throw new IllegalStateError('Got a Workflow activation with no jobs');
              }
              return { state: undefined, output: { close, arr: undefined } };
            }

            if (workflow === undefined) {
              try {
                // Find a workflow start job in the activation jobs list
                // TODO: should this always be the first job in the list?
                const maybeStartWorkflow = task.jobs.find((j) => j.startWorkflow);
                if (maybeStartWorkflow !== undefined) {
                  const attrs = maybeStartWorkflow.startWorkflow;
                  if (!(attrs && attrs.workflowId && attrs.workflowType && attrs.randomnessSeed)) {
                    throw new TypeError(
                      `Expected StartWorkflow with workflowId, workflowType and randomnessSeed, got ${JSON.stringify(
                        maybeStartWorkflow
                      )}`
                    );
                  }
                  this.log.debug('Creating workflow', {
                    taskToken,
                    workflowId: attrs.workflowId,
                    runId: task.runId,
                  });
                  workflow = await Workflow.create(
                    attrs.workflowId,
                    attrs.randomnessSeed,
                    this.options.taskQueue,
                    this.options.activityDefaults
                  );
                  // TODO: this probably shouldn't be here, consider alternative implementation
                  await workflow.inject('console.log', console.log);
                  await workflow.registerActivities(this.resolvedActivities, this.options.activityDefaults);
                  const scriptName = await resolver(
                    this.options.workflowsPath,
                    this.workflowOverrides
                  )(attrs.workflowType);
                  await workflow.registerImplementation(scriptName);
                  numRunningWorkflowInstancesSubject.next(numRunningWorkflowInstancesSubject.value + 1);
                } else {
                  throw new IllegalStateError(
                    'Received workflow activation for an untracked workflow with no start workflow job'
                  );
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

            const arr = await workflow.activate(task.taskToken, task);

            return { state: workflow, output: { close, arr } };
          }, undefined),
          tap(({ close }) => {
            if (close) {
              group$.close();
              numRunningWorkflowInstancesSubject.next(numRunningWorkflowInstancesSubject.value - 1);
            }
          })
        );
      }),
      map(({ arr }) => arr),
      tap(() => {
        numInFlightActivationsSubject.next(numInFlightActivationsSubject.value - 1);
      }),
      filter((arr): arr is Uint8Array => arr !== undefined)
    );
  }

  /**
   * Listen on heartbeats emitted from activities and send them to core.
   * Errors from core responses are translated to cancellation requests and fed back via the activityFeedbackSubject.
   */
  protected activityHeartbeat$(): Observable<void> {
    return this.activityHeartbeatSubject.pipe(
      // Close this observable in case we're not sending anymore heartbeats and thus don't get notified of shutdown
      this.takeUntilState('DRAINED'),
      tap({
        next: ({ taskToken }) => this.log.debug('Got activity heartbeat', { taskToken: formatTaskToken(taskToken) }),
        complete: () => this.log.debug('Heartbeats complete'),
      }),
      mergeMap(async ({ taskToken, details }) => {
        const payload = this.options.dataConverter.toPayload(details);
        const arr = coresdk.ActivityHeartbeat.encodeDelimited({
          taskToken,
          details: [payload],
        }).finish();
        try {
          await this.nativeWorker.recordActivityHeartbeat(
            arr.buffer.slice(arr.byteOffset, arr.byteLength + arr.byteOffset)
          );
        } catch (err) {
          if (err instanceof errors.ShutdownError) {
            throw err;
          }
          // We assume any error here means we should cancel the offending Activity
          this.activityFeedbackSubject.next(
            coresdk.activity_task.ActivityTask.create({
              taskToken,
              // TODO: activityId,
              cancel: {},
            })
          );
        }
      }),
      catchError((err) => (err instanceof errors.ShutdownError ? EMPTY : throwError(err)))
    );
  }

  /**
   * Poll core for `WFActivation`s while respecting worker state
   */
  protected workflowPoll$(): Observable<coresdk.workflow_activation.WFActivation> {
    return this.pollLoop$(async () => {
      try {
        const buffer = await this.nativeWorker.pollWorkflowActivation();
        const task = coresdk.workflow_activation.WFActivation.decode(new Uint8Array(buffer));
        const { taskToken, ...rest } = task;
        this.log.debug('Got workflow activation', { taskToken: formatTaskToken(taskToken), ...rest });
        return task;
      } catch (err) {
        // Transform a Workflow error into an activation with a single removeFromCache job
        if (err instanceof errors.WorkflowError) {
          this.log.warn('Poll resulted in WorkflowError, converting to a removeFromCache job', { runId: err.runId });
          return coresdk.workflow_activation.WFActivation.create({
            runId: err.runId,
            jobs: [{ removeFromCache: true }],
          });
        } else {
          throw err;
        }
      }
    });
  }

  /**
   * Poll for Workflow activations, handle them, and report completions.
   * NOTE: the parameters here are injectable for testing.
   *
   * @param workflowCompletionFeedbackSubject used to send back cache evictions when completing an activation with a WorkflowError
   * @param numInFlightActivationsSubject used to automatically close all of the cached workflows
   * @param numRunningWorkflowInstancesSubject used to monitor the number of workflow instances - useful for testing cleanup.
   */
  protected workflow$(
    workflowCompletionFeedbackSubject = new Subject<coresdk.workflow_activation.WFActivation>(),
    numInFlightActivationsSubject = new BehaviorSubject(0),
    numRunningWorkflowInstancesSubject = new BehaviorSubject(0)
  ): Observable<void> {
    if (this.options.taskQueue === undefined) {
      throw new TypeError('Worker taskQueue not defined');
    }

    // Consume activations from Core and the feedback subject
    return merge(
      this.workflowPoll$(),
      // We can stop subscribing to this when we're in DRAINING state,
      // workflows will eventually be evicted when numInFlightActivations is 0
      workflowCompletionFeedbackSubject.pipe(this.takeUntilState('DRAINING'))
    ).pipe(
      this.workflowOperator(numInFlightActivationsSubject, numRunningWorkflowInstancesSubject),
      mergeMap(async (arr) => {
        try {
          return await this.nativeWorker.completeWorkflowActivation(arr.buffer.slice(arr.byteOffset));
        } catch (err) {
          if (err instanceof errors.WorkflowError) {
            workflowCompletionFeedbackSubject.next(
              coresdk.workflow_activation.WFActivation.create({
                runId: err.runId,
                jobs: [{ removeFromCache: true }],
              })
            );
          } else {
            throw err;
          }
        }
      }),
      tap({ complete: () => this.log.debug('Workflows complete') })
    );
  }
  /**
   * Poll core for `ActivityTask`s while respecting worker state
   */
  protected activityPoll$(): Observable<coresdk.activity_task.ActivityTask> {
    return this.pollLoop$(async () => {
      const buffer = await this.nativeWorker.pollActivityTask();
      const task = coresdk.activity_task.ActivityTask.decode(new Uint8Array(buffer));
      const { taskToken, ...rest } = task;
      this.log.debug('Got activity task', { taskToken: formatTaskToken(taskToken), ...rest });
      return task;
    });
  }

  protected activity$(): Observable<void> {
    return merge(this.activityPoll$(), this.activityFeedbackSubject.pipe(this.takeUntilState('DRAINING'))).pipe(
      this.activityOperator(),
      mergeMap((arr) => this.nativeWorker.completeActivityTask(arr.buffer.slice(arr.byteOffset))),
      tap({ complete: () => this.log.debug('Activities complete') })
    );
  }

  protected takeUntilState<T>(state: State): MonoTypeOperatorFunction<T> {
    return takeUntil(this.stateSubject.pipe(filter((value) => value === state)));
  }

  protected takeUntilIdle<T>(numInFlightActivitiesSubject: Observable<number>): MonoTypeOperatorFunction<T> {
    return takeUntil(
      merge(
        this.stateSubject.pipe(map((state) => ({ state }))),
        numInFlightActivitiesSubject.pipe(map((numInFlightActivations) => ({ numInFlightActivations })))
      ).pipe(
        scan(
          (acc: { state?: State; numInFlightActivations?: number }, curr) => ({
            ...acc,
            ...curr,
          }),
          {}
        ),
        filter(({ state, numInFlightActivations }) => state === 'DRAINING' && numInFlightActivations === 0)
      )
    );
  }

  protected setupShutdownHook(): void {
    const startShutdownSequence = () => {
      for (const signal of this.options.shutdownSignals) {
        process.off(signal, startShutdownSequence);
      }
      this.shutdown();
    };
    for (const signal of this.options.shutdownSignals) {
      process.on(signal, startShutdownSequence);
    }
  }

  /**
   * Start polling on tasks, completes after graceful shutdown.
   * Throws on a fatal error or failure to shutdown gracefully.
   * @see {@link errors}
   *
   * To stop polling call {@link shutdown} or send one of {@link Worker.options.shutdownSignals}.
   */
  async run(): Promise<void> {
    if (this.state !== 'INITIALIZED') {
      throw new IllegalStateError('Poller was aleady started');
    }
    this.state = 'RUNNING';

    this.setupShutdownHook();

    try {
      await merge(
        this.gracefulShutdown$(),
        this.activityHeartbeat$(),
        merge(this.workflow$(), this.activity$()).pipe(
          tap({
            complete: () => {
              this.state = 'DRAINED';
            },
          })
        )
      )
        .pipe(
          tap({
            complete: () => {
              this.state = 'STOPPED';
            },
            error: (error) => {
              this.log.error('Worker failed', { error });
              this.state = 'FAILED';
            },
          })
        )
        .toPromise();
    } finally {
      await this.nativeWorker.breakLoop();
    }
  }
}

type NonNullable<T> = Exclude<T, null | undefined>; // Remove null and undefined from T
type NonNullableObject<T> = { [P in keyof T]-?: NonNullable<T[P]> };

/**
 * Transform an ActivityTask into ActivityInfo to pass on into an Activity
 */
function extractActivityInfo(
  task: coresdk.activity_task.IActivityTask,
  isLocal: boolean,
  dataConverter: DataConverter,
  activityNamespace: string
): ActivityInfo {
  // NOTE: We trust core to supply all of these fields instead of checking for null and undefined everywhere
  const { taskToken, activityId } = task as NonNullableObject<coresdk.activity_task.IActivityTask>;
  const start = task.start as NonNullableObject<coresdk.activity_task.IStart>;
  const activityType = JSON.parse(start.activityType);
  return {
    taskToken,
    activityId,
    workflowExecution: start.workflowExecution as NonNullableObject<coresdk.common.WorkflowExecution>,
    attempt: start.attempt,
    isLocal,
    activityType,
    workflowType: start.workflowType,
    heartbeatDetails: dataConverter.fromPayloads(0, start.heartbeatDetails),
    activityNamespace,
    workflowNamespace: start.workflowNamespace,
    scheduledTimestampMs: tsToMs(start.scheduledTime),
    startToCloseTimeoutMs: tsToMs(start.startToCloseTimeout),
    scheduleToCloseTimeoutMs: tsToMs(start.scheduleToCloseTimeout),
  };
}
