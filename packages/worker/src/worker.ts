import os from 'os';
import { resolve } from 'path';
import { promisify } from 'util';
import * as otel from '@opentelemetry/api';
import {
  BehaviorSubject,
  from,
  merge,
  MonoTypeOperatorFunction,
  Observable,
  OperatorFunction,
  pipe,
  race,
  Subject,
  lastValueFrom,
  EMPTY,
} from 'rxjs';
import { delay, filter, first, ignoreElements, map, mergeMap, takeUntil, takeWhile, tap } from 'rxjs/operators';
import * as native from '@temporalio/core-bridge';
import { coresdk } from '@temporalio/proto';
import { ApplyMode, ExternalDependencies, WorkflowInfo } from '@temporalio/workflow';
import { Info as ActivityInfo } from '@temporalio/activity';
import {
  ActivityOptions,
  IllegalStateError,
  msToNumber,
  tsToMs,
  errorToFailure,
  arrayFromPayloads,
  DataConverter,
  defaultDataConverter,
  ActivityInterface,
  errorMessage,
} from '@temporalio/common';
import { closeableGroupBy, mergeMapWithState } from './rxutils';
import { GiB, MiB } from './utils';
import { Workflow } from './workflow';
import { Activity } from './activity';
import { DefaultLogger, Logger } from './logger';
import { WorkflowIsolateBuilder } from './isolate-builder';
import { IsolateContextProvider, RoundRobinIsolateContextProvider } from './isolate-context-provider';
import * as errors from './errors';
import { childSpan, instrument, tracer } from './tracing';
import { InjectedDependencies, getIvmTransferOptions } from './dependencies';
import { ActivityExecuteInput, WorkerInterceptors } from './interceptors';
export { RetryOptions, IllegalStateError } from '@temporalio/common';
export { ActivityOptions, DataConverter, defaultDataConverter, errors };
import { Core } from './core';

native.registerErrors(errors);

/**
 * Customize the Worker according to spec.
 *
 * Pass as a type parameter to {@link Worker.create} to alter the accepted {@link WorkerSpecOptions}
 */
export interface WorkerSpec {
  dependencies?: ExternalDependencies;
}

export interface DefaultWorkerSpec extends WorkerSpec {
  dependencies: undefined;
}

/**
 * Same as {@link WorkerOptions} with {@link WorkerSpec} applied
 */
export type WorkerSpecOptions<T extends WorkerSpec> = T extends { dependencies: ExternalDependencies }
  ? { dependencies: InjectedDependencies<T['dependencies']> } & WorkerOptions
  : WorkerOptions;

/**
 * Options to configure the {@link Worker}
 */
export interface WorkerOptions {
  /**
   * The task queue the worker will pull from
   */
  taskQueue: string;

  /**
   * If provided, automatically discover Workflows and Activities relative to path.
   *
   * @see {@link activities}, {@link workflowsPath}, and {@link nodeModulesPath}
   */
  workDir?: string;

  /**
   * Mapping of activity name to implementation.
   *
   * Automatically discovered from `${workDir}/activities` if {@link workDir} is provided.
   */
  activities?: ActivityInterface;

  /**
   * Path to look up workflows in.
   * Automatically discovered if {@link workDir} is provided.
   * @default ${workDir}/workflows
   */
  workflowsPath?: string;

  /**
   * Path for webpack to look up modules in for bundling the Workflow code.
   * Automatically discovered if {@link workDir} is provided.
   * @default ${workDir}/../node_modules
   */
  nodeModulesPath?: string;

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  shutdownGraceTime?: string | number;

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
   * Maximum number of Activity tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 100
   */
  maxConcurrentActivityTaskExecutions?: number;
  /**
   * Maximum number of Workflow tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 100
   */
  maxConcurrentWorkflowTaskExecutions?: number;

  /**
   * Maximum number of concurrent poll Workflow task requests to perform at a time.
   * Higher values will result in higher throughput and load on the Worker.
   * If your Worker is overloaded, tasks might start timing out in which case, reduce this value.
   *
   * @default 5
   */
  maxConcurrentWorkflowTaskPolls?: number;
  /**
   * Maximum number of concurrent poll Activity task requests to perform at a time.
   * Higher values will result in higher throughput and load on the Worker.
   * If your Worker is overloaded, tasks might start timing out in which case, reduce this value.
   *
   * @default 5
   */
  maxConcurrentActivityTaskPolls?: number;

  /**
   * `maxConcurrentWorkflowTaskPolls` * this number = the number of max pollers that will
   * be allowed for the nonsticky queue when sticky tasks are enabled. If both defaults are used,
   * the sticky queue will allow 4 max pollers while the nonsticky queue will allow one. The
   * minimum for either poller is 1, so if `max_concurrent_wft_polls` is 1 and sticky queues are
   * enabled, there will be 2 concurrent polls.
   * @default 0.2
   */
  nonStickyToStickyPollRatio?: number;

  /**
   * How long a workflow task is allowed to sit on the sticky queue before it is timed out
   * and moved to the non-sticky queue where it may be picked up by any worker.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   * @default 10s
   */
  stickyQueueScheduleToStartTimeout?: string;

  /**
   * Time to wait for result when calling a Workflow isolate function.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   * @default 1s
   */
  isolateExecutionTimeout?: string | number;

  /**
   * Memory limit in MB for the Workflow v8 isolate.
   *
   * If this limit is exceeded the isolate will be disposed and the worker will crash.
   *
   * @default `max(os.totalmem() - 1GiB, 1GiB)`
   */
  maxIsolateMemoryMB?: number;

  /**
   * Controls number of v8 isolates the Worker should create.
   *
   * New Workflows are created on this pool in a round-robin fashion.
   *
   * @default 8
   */
  isolatePoolSize?: number;

  /**
   * The number of Workflow isolates to keep in cached in memory
   *
   * Cached Workflows continue execution from their last stopping point.
   * If the Worker is asked to run an uncached Workflow, it will need to replay the entire Workflow history.
   * Use as a dial for trading memory for CPU time.
   *
   * You should be able to fit about 500 Workflows per GB of memory dependening on your Workflow bundle size.
   * For the SDK test Workflows, we managed to fit 750 Workflows per GB.
   *
   * This number is impacted by the the Worker's {@link maxIsolateMemoryMB} option.
   *
   * @default `max(os.totalmem() / 1GiB - 1, 1) * 500`
   */
  maxCachedWorkflows?: number;

  /**
   * A mapping of interceptor type to a list of factories or module paths
   */
  interceptors?: WorkerInterceptors;
  // TODO: implement all of these
  // maxConcurrentLocalActivityExecutions?: number; // defaults to 200
  // maxTaskQueueActivitiesPerSecond?: number;
  // maxWorkerActivitiesPerSecond?: number;
  // isLocalActivityWorkerOnly?: boolean; // defaults to false
}

/**
 * WorkerOptions with all of the Worker required attributes
 */
export type WorkerOptionsWithDefaults<T extends WorkerSpec = DefaultWorkerSpec> = WorkerOptions & {
  dependencies: T['dependencies'] extends ExternalDependencies ? InjectedDependencies<T['dependencies']> : undefined;
} & Required<
    Pick<
      WorkerOptions,
      | 'shutdownGraceTime'
      | 'shutdownSignals'
      | 'dataConverter'
      | 'maxConcurrentActivityTaskExecutions'
      | 'maxConcurrentWorkflowTaskExecutions'
      | 'maxConcurrentActivityTaskPolls'
      | 'maxConcurrentWorkflowTaskPolls'
      | 'nonStickyToStickyPollRatio'
      | 'stickyQueueScheduleToStartTimeout'
      | 'isolateExecutionTimeout'
      | 'maxIsolateMemoryMB'
      | 'isolatePoolSize'
      | 'maxCachedWorkflows'
    >
  >;

/**
 * {@link WorkerOptions} where the attributes the Worker requires are required and time units are converted from ms formatted strings to numbers.
 */
export interface CompiledWorkerOptions<T extends WorkerSpec = DefaultWorkerSpec>
  extends Omit<WorkerOptionsWithDefaults<T>, 'serverOptions'> {
  shutdownGraceTimeMs: number;
  isolateExecutionTimeoutMs: number;
  stickyQueueScheduleToStartTimeoutMs: number;
}

/**
 * Type assertion helper for working with conditional dependencies
 */
function includesDeps<T extends WorkerSpec>(
  options: unknown
): options is WorkerSpecOptions<T & { dependencies: ExternalDependencies }> {
  return (options as WorkerSpecOptions<{ dependencies: ExternalDependencies }>).dependencies !== undefined;
}

export function addDefaults<T extends WorkerSpec>(options: WorkerSpecOptions<T>): WorkerOptionsWithDefaults<T> {
  const { workDir, ...rest } = options;
  // Typescript is really struggling with the conditional exisitence of the dependencies attribute.
  // Help it out without sacrificing type safety of the other attributes.
  const ret: Omit<WorkerOptionsWithDefaults<T>, 'dependencies'> = {
    activities: workDir && !('activities' in rest) ? require(resolve(workDir, 'activities')) : undefined,
    workflowsPath: workDir ? resolve(workDir, 'workflows') : undefined,
    nodeModulesPath: workDir ? resolve(workDir, '../node_modules') : undefined,
    shutdownGraceTime: '5s',
    shutdownSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT'],
    dataConverter: defaultDataConverter,
    logger: new DefaultLogger(),
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentWorkflowTaskExecutions: 100,
    maxConcurrentActivityTaskPolls: 5,
    maxConcurrentWorkflowTaskPolls: 5,
    nonStickyToStickyPollRatio: 0.2,
    stickyQueueScheduleToStartTimeout: '10s',
    isolateExecutionTimeout: '1s',
    maxIsolateMemoryMB: Math.max(os.totalmem() - GiB, GiB) / MiB,
    isolatePoolSize: 8,
    maxCachedWorkflows: options.maxCachedWorkflows || Math.max(os.totalmem() / GiB - 1, 1) * 500,
    ...rest,
  };
  return ret as WorkerOptionsWithDefaults<T>;
}

export function compileWorkerOptions<T extends WorkerSpec>(
  opts: WorkerOptionsWithDefaults<T>
): CompiledWorkerOptions<T> {
  return {
    ...opts,
    shutdownGraceTimeMs: msToNumber(opts.shutdownGraceTime),
    stickyQueueScheduleToStartTimeoutMs: msToNumber(opts.stickyQueueScheduleToStartTimeout),
    isolateExecutionTimeoutMs: msToNumber(opts.isolateExecutionTimeout),
  };
}

/**
 * The worker's possible states
 * * `INITIALIZED` - The initial state of the Worker after calling {@link Worker.create} and successful connection to the server
 * * `RUNNING` - {@link Worker.run} was called, polling task queues
 * * `STOPPING` - {@link Worker.shutdown} was called or received shutdown signal, worker will forcefully shutdown in {@link WorkerOptions.shutdownGraceTime | shutdownGraceTime}
 * * `DRAINING` - Core has indicated that shutdown is complete and all Workflow tasks have been drained, waiting for activities and cached workflows eviction
 * * `DRAINED` - All activities and workflows have completed, ready to shutdown
 * * `STOPPED` - Shutdown complete, {@link Worker.run} resolves
 * * `FAILED` - Worker encountered an unrecoverable error, {@link Worker.run} should reject with the error
 */
export type State = 'INITIALIZED' | 'RUNNING' | 'STOPPED' | 'STOPPING' | 'DRAINING' | 'DRAINED' | 'FAILED';

type ExtractToPromise<T> = T extends (err: any, result: infer R) => void ? Promise<R> : never;
// For some reason the lint rule doesn't realize that _I should be ignored
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Last<T extends any[]> = T extends [...infer _I, infer L] ? L : never;
type LastParameter<F extends (...args: any) => any> = Last<Parameters<F>>;
type OmitFirst<T> = T extends [any, ...infer REST] ? REST : never;
type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
type OmitFirstParam<T> = T extends (...args: any[]) => any
  ? (...args: OmitFirst<Parameters<T>>) => ReturnType<T>
  : never;
type Promisify<T> = T extends (...args: any[]) => void
  ? (...args: OmitLast<Parameters<T>>) => ExtractToPromise<LastParameter<T>>
  : never;

type ContextAware<T> = T & {
  parentSpan: otel.Span;
};

export type ActivationWithContext = ContextAware<{
  activation: coresdk.workflow_activation.WFActivation;
}>;
export type ActivityTaskWithContext = ContextAware<{
  task: coresdk.activity_task.ActivityTask;
  formattedTaskToken: string;
}>;

export interface NativeWorkerLike {
  shutdown: Promisify<OmitFirstParam<typeof native.workerShutdown>>;
  completeShutdown(): Promise<void>;
  pollWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerPollWorkflowActivation>>;
  pollActivityTask: Promisify<OmitFirstParam<typeof native.workerPollActivityTask>>;
  completeWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerCompleteWorkflowActivation>>;
  completeActivityTask: Promisify<OmitFirstParam<typeof native.workerCompleteActivityTask>>;
  recordActivityHeartbeat: OmitFirstParam<typeof native.workerRecordActivityHeartbeat>;
  namespace: string;
  logger: Logger;
}

export interface WorkerConstructor {
  create(options: CompiledWorkerOptions): Promise<NativeWorkerLike>;
}

export class NativeWorker implements NativeWorkerLike {
  public readonly pollWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerPollWorkflowActivation>>;
  public readonly pollActivityTask: Promisify<OmitFirstParam<typeof native.workerPollActivityTask>>;
  public readonly completeWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerCompleteWorkflowActivation>>;
  public readonly completeActivityTask: Promisify<OmitFirstParam<typeof native.workerCompleteActivityTask>>;
  public readonly recordActivityHeartbeat: OmitFirstParam<typeof native.workerRecordActivityHeartbeat>;
  public readonly shutdown: Promisify<OmitFirstParam<typeof native.workerShutdown>>;

  public static async create(options: CompiledWorkerOptions): Promise<NativeWorkerLike> {
    const core = await Core.instance();
    const nativeWorker = await core.registerWorker(options);
    return new NativeWorker(core, nativeWorker);
  }

  protected constructor(protected readonly core: Core, protected readonly nativeWorker: native.Worker) {
    this.pollWorkflowActivation = promisify(native.workerPollWorkflowActivation).bind(undefined, nativeWorker);
    this.pollActivityTask = promisify(native.workerPollActivityTask).bind(undefined, nativeWorker);
    this.completeWorkflowActivation = promisify(native.workerCompleteWorkflowActivation).bind(undefined, nativeWorker);
    this.completeActivityTask = promisify(native.workerCompleteActivityTask).bind(undefined, nativeWorker);
    this.recordActivityHeartbeat = native.workerRecordActivityHeartbeat.bind(undefined, nativeWorker);
    this.shutdown = promisify(native.workerShutdown).bind(undefined, nativeWorker);
  }

  public async completeShutdown(): Promise<void> {
    await this.core.deregisterWorker(this.nativeWorker);
  }

  public get namespace(): string {
    return this.core.options.serverOptions.namespace;
  }

  public get logger(): Logger {
    return this.core.options.logger;
  }
}

function formatTaskToken(taskToken: Uint8Array) {
  return Buffer.from(taskToken).toString('base64');
}

/**
 * The temporal worker connects to the service and runs workflows and activities.
 */
export class Worker<T extends WorkerSpec = DefaultWorkerSpec> {
  protected readonly workflowOverrides: Map<string, string> = new Map();
  protected readonly activityHeartbeatSubject = new Subject<{
    taskToken: Uint8Array;
    details?: any;
  }>();
  protected readonly stateSubject = new BehaviorSubject<State>('INITIALIZED');
  protected readonly numInFlightActivationsSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly numRunningWorkflowInstancesSubject = new BehaviorSubject<number>(0);

  protected static nativeWorkerCtor: WorkerConstructor = NativeWorker;
  protected nextIsolateIdx = 0;

  /**
   * Create a new Worker.
   * This method initiates a connection to the server and will throw (asynchronously) on connection failure.
   */
  public static async create<T extends WorkerSpec = DefaultWorkerSpec>(
    options: WorkerSpecOptions<T>
  ): Promise<Worker<T>> {
    const nativeWorkerCtor: WorkerConstructor = this.nativeWorkerCtor;
    const compiledOptions = compileWorkerOptions(addDefaults(options));
    // Pass dependencies as undefined to please the type checker
    const nativeWorker = await nativeWorkerCtor.create({ ...compiledOptions, dependencies: undefined });
    let contextProvider: IsolateContextProvider | undefined = undefined;
    // Allow only both or none to be provided
    if (Boolean(compiledOptions.workflowsPath) !== Boolean(compiledOptions.nodeModulesPath)) {
      throw new TypeError(
        'Could not build isolates for the worker due to missing WorkerOptions. Make sure you specify the `workDir` option, or both the `workflowsPath` and `nodeModulesPath` options.'
      );
    }
    if (compiledOptions.workflowsPath && compiledOptions.nodeModulesPath) {
      const builder = new WorkflowIsolateBuilder(
        nativeWorker.logger,
        compiledOptions.nodeModulesPath,
        compiledOptions.workflowsPath,
        compiledOptions.interceptors?.workflowModules
      );
      contextProvider = await RoundRobinIsolateContextProvider.create(
        builder,
        compiledOptions.isolatePoolSize,
        compiledOptions.maxIsolateMemoryMB
      );
    }

    return new this(nativeWorker, contextProvider, compiledOptions);
  }

  /**
   * Create a new Worker from nativeWorker.
   */
  protected constructor(
    protected readonly nativeWorker: NativeWorkerLike,
    /**
     * Optional IsolateContextProvider - if not provided, Worker will not poll on workflows
     */
    protected readonly isolateContextProvider: IsolateContextProvider | undefined,
    public readonly options: CompiledWorkerOptions<T>
  ) {}

  /**
   * An Observable which emits each time the number of in flight activations changes
   */
  public get numInFlightActivations$(): Observable<number> {
    return this.numInFlightActivationsSubject;
  }

  /**
   * An Observable which emits each time the number of in flight activity tasks changes
   */
  public get numInFlightActivities$(): Observable<number> {
    return this.numInFlightActivitiesSubject;
  }

  /**
   * An Observable which emits each time the number of in flight activations changes
   */
  public get numRunningWorkflowInstances$(): Observable<number> {
    return this.numRunningWorkflowInstancesSubject;
  }

  protected get log(): Logger {
    return this.nativeWorker.logger;
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
   * Start shutting down the Worker.
   * Immediately transitions state to STOPPING and asks Core to shut down.
   * Once Core has confirmed that it's shutting down the Worker enters DRAINING state
   * unless the Worker has already been DRAINED.
   * {@see State}.
   */
  shutdown(): void {
    if (this.state !== 'RUNNING') {
      throw new IllegalStateError('Not running');
    }
    this.state = 'STOPPING';
    this.nativeWorker.shutdown().then(() => {
      // Core may have already returned a ShutdownError to our pollers in which
      // case the state would transition to DRAINED
      if (this.state === 'STOPPING') {
        this.state = 'DRAINING';
      }
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
    return from(
      (async function* () {
        for (;;) {
          try {
            yield await pollFn();
          } catch (err) {
            if (err instanceof errors.ShutdownError) {
              break;
            }
            throw err;
          }
        }
      })()
    );
  }

  /**
   * Process activity tasks
   */
  protected activityOperator(): OperatorFunction<ActivityTaskWithContext, ContextAware<{ completion: Uint8Array }>> {
    return pipe(
      closeableGroupBy(({ formattedTaskToken }) => formattedTaskToken),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(
            async (activity: Activity | undefined, { task, parentSpan, formattedTaskToken }) => {
              const { taskToken, variant, activityId } = task;
              if (!variant) {
                throw new TypeError('Got an activity task without a "variant" attribute');
              }

              return await instrument(parentSpan, `activity.${variant}`, async (span) => {
                // We either want to return an activity result (for failures) or pass on the activity for running at a later stage
                // If cancel is requested we ignore the result of this function
                // We don't run the activity directly in this operator because we need to return the activity in the state
                // so it can be cancelled if requested
                let output:
                  | { type: 'result'; result: coresdk.activity_result.IActivityResult; parentSpan: otel.Span }
                  | { type: 'run'; activity: Activity; input: ActivityExecuteInput; parentSpan: otel.Span }
                  | { type: 'ignore'; parentSpan: otel.Span };
                switch (variant) {
                  case 'start': {
                    if (activity !== undefined) {
                      throw new IllegalStateError(
                        `Got start event for an already running activity: ${formattedTaskToken}`
                      );
                    }
                    const info = await extractActivityInfo(
                      task,
                      false,
                      this.options.dataConverter,
                      this.nativeWorker.namespace
                    );
                    const { activityType } = info;
                    const fn = this.options.activities?.[activityType];
                    if (!(fn instanceof Function)) {
                      output = {
                        type: 'result',
                        result: {
                          failed: {
                            failure: {
                              message: `Activity function ${activityType} is not registered on this Worker, available activities: ${JSON.stringify(
                                Object.keys(this.options.activities ?? {})
                              )}`,
                              applicationFailureInfo: { type: 'NotFoundError', nonRetryable: true },
                            },
                          },
                        },
                        parentSpan,
                      };
                      break;
                    }
                    let args: unknown[];
                    try {
                      args = await arrayFromPayloads(this.options.dataConverter, task.start?.input);
                    } catch (err) {
                      output = {
                        type: 'result',
                        result: {
                          failed: {
                            failure: {
                              message: `Failed to parse activity args for activity ${activityType}: ${errorMessage(
                                err
                              )}`,
                              applicationFailureInfo: {
                                type: err instanceof Error ? err.name : undefined,
                                nonRetryable: true,
                              },
                            },
                          },
                        },
                        parentSpan,
                      };
                      break;
                    }
                    const headers = task.start?.headerFields ?? {};
                    const input = {
                      args,
                      headers,
                    };
                    this.log.debug('Starting activity', { activityId, activityType });

                    activity = new Activity(
                      info,
                      fn,
                      this.options.dataConverter,
                      (details) =>
                        this.activityHeartbeatSubject.next({
                          taskToken,
                          details,
                        }),
                      { inbound: this.options.interceptors?.activityInbound }
                    );
                    this.numInFlightActivitiesSubject.next(this.numInFlightActivitiesSubject.value + 1);
                    output = { type: 'run', activity, input, parentSpan };
                    break;
                  }
                  case 'cancel': {
                    output = { type: 'ignore', parentSpan };
                    if (activity === undefined) {
                      this.log.error('Tried to cancel a non-existing activity', { activityId });
                      span.setAttribute('found', false);
                      break;
                    }
                    // NOTE: activity will not be considered cancelled until it confirms cancellation
                    this.log.debug('Cancelling activity', { activityId });
                    span.setAttribute('found', true);
                    activity.cancel();
                    break;
                  }
                }
                return { state: activity, output: { taskToken, output } };
              });
            },
            undefined // initial value
          ),
          mergeMap(async ({ output, taskToken }) => {
            if (output.type === 'ignore') {
              output.parentSpan.end();
              return undefined;
            }
            if (output.type === 'result') {
              return { taskToken, result: output.result, parentSpan: output.parentSpan };
            }
            return await instrument(output.parentSpan, 'activity.run', async (span) => {
              const result = await output.activity.run(output.input);
              const status = result.failed ? 'failed' : result.completed ? 'completed' : 'cancelled';
              span.setAttributes({ status });
              this.log.debug('Activity resolved', { activityId: output.activity.info.activityId, status });
              return { taskToken, result, parentSpan: output.parentSpan };
            });
          }),
          filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
          map(({ parentSpan, ...rest }) => ({
            completion: coresdk.ActivityTaskCompletion.encodeDelimited(rest).finish(),
            parentSpan,
          })),
          tap(group$.close), // Close the group after activity task completion
          tap(() => void this.numInFlightActivitiesSubject.next(this.numInFlightActivitiesSubject.value - 1))
        );
      })
    );
  }

  /**
   * Process workflow activations
   */
  protected workflowOperator(): OperatorFunction<ActivationWithContext, ContextAware<{ completion: Uint8Array }>> {
    const { isolateContextProvider } = this;
    if (isolateContextProvider === undefined) {
      throw new IllegalStateError('Cannot process workflows without an IsolateContextProvider');
    }
    return pipe(
      closeableGroupBy(({ activation }) => activation.runId),
      mergeMap((group$) => {
        return merge(
          group$.pipe(map((act) => ({ ...act, synthetic: false }))),
          this.stateSubject.pipe(
            // Core has indicated that it will not return any more poll results, evict all cached WFs
            filter((state) => state === 'DRAINING'),
            first(),
            map((): ContextAware<{ activation: coresdk.workflow_activation.WFActivation; synthetic: true }> => {
              return {
                parentSpan: tracer.startSpan('workflow.shutdown.evict'),
                activation: new coresdk.workflow_activation.WFActivation({
                  runId: group$.key,
                  jobs: [{ removeFromCache: true }],
                }),
                synthetic: true,
              };
            })
          )
        ).pipe(
          tap(() => {
            this.numInFlightActivationsSubject.next(this.numInFlightActivationsSubject.value + 1);
          }),
          mergeMapWithState(
            async (
              workflow: Workflow | undefined,
              { activation, parentSpan, synthetic }
            ): Promise<{
              state: Workflow | undefined;
              output: ContextAware<{ completion?: Uint8Array; close: boolean }>;
            }> => {
              try {
                return await instrument(parentSpan, 'workflow.process', async (span) => {
                  span.setAttributes({
                    numInFlightActivations: this.numInFlightActivationsSubject.value,
                    numRunningWorkflowInstances: this.numRunningWorkflowInstancesSubject.value,
                  });
                  const jobs = activation.jobs.filter(({ removeFromCache }) => !removeFromCache);
                  // Found a removeFromCache job
                  const close = jobs.length < activation.jobs.length;
                  activation.jobs = jobs;
                  if (jobs.length === 0) {
                    workflow?.dispose();
                    if (!close) {
                      const message = 'Got a Workflow activation with no jobs';
                      throw new IllegalStateError(message);
                    }
                    this.log.debug('Disposing workflow', { runId: activation.runId });
                    const completion = synthetic
                      ? undefined
                      : coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
                          runId: activation.runId,
                          successful: {},
                        }).finish();
                    return { state: undefined, output: { close, completion, parentSpan } };
                  }

                  if (workflow === undefined) {
                    // Find a workflow start job in the activation jobs list
                    const maybeStartWorkflow = activation.jobs.find((j) => j.startWorkflow);
                    if (maybeStartWorkflow !== undefined) {
                      const startWorkflow = maybeStartWorkflow.startWorkflow;
                      if (
                        !(
                          startWorkflow &&
                          startWorkflow.workflowId &&
                          startWorkflow.workflowType &&
                          startWorkflow.randomnessSeed
                        )
                      ) {
                        throw new TypeError(
                          `Expected StartWorkflow with workflowId, workflowType and randomnessSeed, got ${JSON.stringify(
                            maybeStartWorkflow
                          )}`
                        );
                      }
                      const { workflowId, randomnessSeed, workflowType } = startWorkflow;
                      this.log.debug('Creating workflow', {
                        workflowId,
                        runId: activation.runId,
                      });
                      this.numRunningWorkflowInstancesSubject.next(this.numRunningWorkflowInstancesSubject.value + 1);
                      // workflow type is Workflow | undefined which doesn't work in the instrumented closures, create add local variable with type Workflow.
                      const createdWF = await instrument(span, 'workflow.create', async () => {
                        const context = await isolateContextProvider.getContext();

                        return await Workflow.create(
                          context,
                          {
                            workflowType,
                            runId: activation.runId,
                            workflowId,
                            namespace: this.nativeWorker.namespace,
                            taskQueue: this.options.taskQueue,
                            isReplaying: activation.isReplaying,
                          },
                          this.options.interceptors?.workflowModules ?? [],
                          randomnessSeed,
                          startWorkflow,
                          this.options.isolateExecutionTimeoutMs
                        );
                      });
                      workflow = createdWF;
                      await instrument(span, 'workflow.inject.dependencies', () => this.injectDependencies(createdWF));
                    } else {
                      throw new IllegalStateError(
                        'Received workflow activation for an untracked workflow with no start workflow job'
                      );
                    }
                  }

                  const completion = await workflow.activate(activation);
                  this.log.debug('Completed activation', {
                    runId: activation.runId,
                  });

                  span.setAttribute('close', close).end();
                  return { state: workflow, output: { close, completion, parentSpan } };
                });
              } catch (error) {
                this.log.error('Failed to activate workflow', {
                  runId: activation.runId,
                  error,
                  workflowExists: workflow !== undefined,
                });
                const completion = coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
                  runId: activation.runId,
                  failed: {
                    failure: await errorToFailure(error, this.options.dataConverter),
                  },
                }).finish();
                // TODO: should we wait to be evicted from core?
                workflow?.dispose();
                return { state: undefined, output: { close: true, completion, parentSpan } };
              }
            },
            undefined
          ),
          tap(({ close }) => {
            this.numInFlightActivationsSubject.next(this.numInFlightActivationsSubject.value - 1);
            if (close) {
              group$.close();
              this.numRunningWorkflowInstancesSubject.next(this.numRunningWorkflowInstancesSubject.value - 1);
            }
          }),
          takeWhile(({ close }) => !close, true /* inclusive */)
        );
      }),
      map(({ completion, parentSpan }) => ({ completion, parentSpan })),
      filter((result): result is ContextAware<{ completion: Uint8Array }> => result.completion !== undefined)
    );
  }

  /**
   * Inject default console log and user provided external dependencies into a Workflow isolate
   */
  protected async injectDependencies(workflow: Workflow): Promise<void> {
    await workflow.injectGlobal(
      'console.log',
      (...args: any[]) => {
        if (workflow.info.isReplaying) return;
        console.log(`${workflow.info.workflowType} ${workflow.info.runId} >`, ...args);
      },
      ApplyMode.SYNC
    );

    if (includesDeps(this.options)) {
      for (const [ifaceName, dep] of Object.entries(this.options.dependencies)) {
        for (const [fnName, impl] of Object.entries(dep)) {
          await workflow.injectDependency(
            ifaceName,
            fnName,
            (...args) => {
              if (!impl.callDuringReplay && workflow.info.isReplaying) return;
              try {
                const ret = impl.fn(workflow.info, ...args);
                if (ret instanceof Promise) {
                  return ret.catch((error) => this.handleExternalDependencyError(workflow.info, impl.applyMode, error));
                }
                return ret;
              } catch (error) {
                this.handleExternalDependencyError(workflow.info, impl.applyMode, error);
              }
            },
            impl.applyMode,
            getIvmTransferOptions(impl)
          );
        }
      }
    }
  }

  /**
   * Listen on heartbeats emitted from activities and send them to core.
   * Errors from core responses are translated to cancellation requests and fed back via the activityFeedbackSubject.
   */
  protected activityHeartbeat$(): Observable<void> {
    return this.activityHeartbeatSubject.pipe(
      // The only way for this observable to be closed is by state changing to DRAINED meaning that all in-flight activities have been resolved and thus there should not be any heartbeats to send.
      this.takeUntilState('DRAINED'),
      tap({
        next: ({ taskToken }) => this.log.debug('Got activity heartbeat', { taskToken: formatTaskToken(taskToken) }),
        complete: () => this.log.debug('Heartbeats complete'),
      }),
      mergeMap(async ({ taskToken, details }) => {
        const payload = await this.options.dataConverter.toPayload(details);
        const arr = coresdk.ActivityHeartbeat.encodeDelimited({
          taskToken,
          details: [payload],
        }).finish();
        this.nativeWorker.recordActivityHeartbeat(arr.buffer.slice(arr.byteOffset, arr.byteLength + arr.byteOffset));
      })
    );
  }

  /**
   * Poll core for `WFActivation`s while respecting worker state
   */
  protected workflowPoll$(): Observable<ActivationWithContext> {
    return this.pollLoop$(async () => {
      const parentSpan = tracer.startSpan('workflow.activation');
      try {
        return await instrument(parentSpan, 'workflow.poll', async (span) => {
          const buffer = await this.nativeWorker.pollWorkflowActivation();
          const activation = coresdk.workflow_activation.WFActivation.decode(new Uint8Array(buffer));
          const { runId, ...rest } = activation;
          this.log.debug('Got workflow activation', { runId, ...rest });
          span.setAttribute('runId', runId).setAttribute('numJobs', rest.jobs.length);
          return { activation, parentSpan };
        });
      } catch (err) {
        // Transform a Workflow error into an activation with a single removeFromCache job
        if (err instanceof errors.WorkflowError) {
          this.log.warn('Poll resulted in WorkflowError, converting to a removeFromCache job', { runId: err.runId });
          return {
            parentSpan,
            activation: new coresdk.workflow_activation.WFActivation({
              runId: err.runId,
              jobs: [{ removeFromCache: true }],
            }),
          };
        } else {
          parentSpan.setStatus({ code: otel.SpanStatusCode.ERROR }).end();
          throw err;
        }
      }
    });
  }

  /**
   * Poll for Workflow activations, handle them, and report completions.
   */
  protected workflow$(): Observable<void> {
    if (this.isolateContextProvider === undefined) {
      return EMPTY;
    }
    if (this.options.taskQueue === undefined) {
      throw new TypeError('Worker taskQueue not defined');
    }

    return this.workflowPoll$().pipe(
      this.workflowOperator(),
      mergeMap(async ({ completion, parentSpan: root }) => {
        const span = childSpan(root, 'workflow.complete');
        try {
          await this.nativeWorker.completeWorkflowActivation(completion.buffer.slice(completion.byteOffset));
          span.setStatus({ code: otel.SpanStatusCode.OK });
        } catch (err) {
          span.setStatus({ code: otel.SpanStatusCode.ERROR, message: errorMessage(err) });
          // Expect Core to issue an eviction in this case
          if (!(err instanceof errors.WorkflowError)) {
            throw err;
          }
        } finally {
          span.end();
          root.end();
        }
      }),
      tap({ complete: () => this.log.debug('Workflows complete') })
    );
  }
  /**
   * Poll core for `ActivityTask`s while respecting worker state
   */
  protected activityPoll$(): Observable<ActivityTaskWithContext> {
    return this.pollLoop$(async () => {
      const parentSpan = tracer.startSpan('activity.task');
      try {
        return await instrument(parentSpan, 'activity.poll', async () => {
          const buffer = await this.nativeWorker.pollActivityTask();
          const task = coresdk.activity_task.ActivityTask.decode(new Uint8Array(buffer));
          const { taskToken, ...rest } = task;
          const formattedTaskToken = formatTaskToken(taskToken);
          this.log.debug('Got activity task', { taskToken: formattedTaskToken, ...rest });
          const { variant } = task;
          if (variant === undefined) {
            throw new TypeError('Got an activity task without a "variant" attribute');
          }
          parentSpan.setAttribute('taskToken', formattedTaskToken).setAttribute('variant', variant);
          return { task, parentSpan, formattedTaskToken };
        });
      } catch (err) {
        parentSpan.setStatus({ code: otel.SpanStatusCode.ERROR }).end();
        throw err;
      }
    });
  }

  protected activity$(): Observable<void> {
    // TODO: Let core know that we're not interested in polling on activities
    // Don't even bother polling if no activities have been registered
    if (this.options.activities === undefined || Object.keys(this.options.activities).length === 0) {
      return EMPTY;
    }
    return this.activityPoll$().pipe(
      this.activityOperator(),
      mergeMap(async ({ completion, parentSpan }) => {
        try {
          await instrument(parentSpan, 'activity.complete', () =>
            this.nativeWorker.completeActivityTask(completion.buffer.slice(completion.byteOffset))
          );
        } finally {
          parentSpan.end();
        }
      }),
      tap({ complete: () => this.log.debug('Activities complete') })
    );
  }

  protected takeUntilState<T>(state: State): MonoTypeOperatorFunction<T> {
    return takeUntil(this.stateSubject.pipe(filter((value) => value === state)));
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
      await lastValueFrom(
        merge(
          this.gracefulShutdown$(),
          this.activityHeartbeat$(),
          merge(this.workflow$(), this.activity$()).pipe(
            tap({
              complete: () => {
                this.state = 'DRAINED';
              },
            })
          )
        ).pipe(
          tap({
            complete: () => {
              this.state = 'STOPPED';
            },
            error: (error) => {
              this.log.error('Worker failed', { error });
              this.state = 'FAILED';
            },
          })
        ),
        { defaultValue: undefined }
      );
    } finally {
      await this.nativeWorker.completeShutdown();
      this.isolateContextProvider?.destroy();
    }
  }

  /**
   * Log when an external dependency function throws an error in IGNORED mode and throw otherwise
   */
  protected handleExternalDependencyError(workflowInfo: WorkflowInfo, applyMode: ApplyMode, error: unknown): void {
    if (applyMode === ApplyMode.SYNC_IGNORED || applyMode === ApplyMode.ASYNC_IGNORED) {
      this.log.error('External dependency function threw an error', {
        workflowInfo,
        error,
      });
    } else {
      throw error;
    }
  }
}

type NonNullable<T> = Exclude<T, null | undefined>; // Remove null and undefined from T
type NonNullableObject<T> = { [P in keyof T]-?: NonNullable<T[P]> };

/**
 * Transform an ActivityTask into ActivityInfo to pass on into an Activity
 */
async function extractActivityInfo(
  task: coresdk.activity_task.IActivityTask,
  isLocal: boolean,
  dataConverter: DataConverter,
  activityNamespace: string
): Promise<ActivityInfo> {
  // NOTE: We trust core to supply all of these fields instead of checking for null and undefined everywhere
  const { taskToken, activityId } = task as NonNullableObject<coresdk.activity_task.IActivityTask>;
  const start = task.start as NonNullableObject<coresdk.activity_task.IStart>;
  return {
    taskToken,
    activityId,
    workflowExecution: start.workflowExecution as NonNullableObject<coresdk.common.WorkflowExecution>,
    attempt: start.attempt,
    isLocal,
    activityType: start.activityType,
    workflowType: start.workflowType,
    heartbeatDetails: await dataConverter.fromPayloads(0, start.heartbeatDetails),
    activityNamespace,
    workflowNamespace: start.workflowNamespace,
    scheduledTimestampMs: tsToMs(start.scheduledTime),
    startToCloseTimeoutMs: tsToMs(start.startToCloseTimeout),
    scheduleToCloseTimeoutMs: tsToMs(start.scheduleToCloseTimeout),
  };
}
