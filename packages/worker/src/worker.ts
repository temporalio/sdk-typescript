import * as otel from '@opentelemetry/api';
import { SpanContext } from '@opentelemetry/api';
import { Info as ActivityInfo } from '@temporalio/activity';
import {
  DataConverter,
  defaultPayloadConverter,
  errorMessage,
  IllegalStateError,
  LoadedDataConverter,
  mapFromPayloads,
  Payload,
  searchAttributePayloadConverter,
} from '@temporalio/common';
import * as native from '@temporalio/core-bridge';
import {
  decodeArrayFromPayloads,
  decodeFromPayloadsAtIndex,
  decodeMapFromPayloads,
  decodeOptionalFailureToOptionalError,
  encodeErrorToFailure,
  encodeToPayload,
} from '@temporalio/internal-non-workflow-common';
import {
  extractSpanContextFromHeaders,
  linkSpans,
  NUM_JOBS_ATTR_KEY,
  RUN_ID_ATTR_KEY,
  TASK_TOKEN_ATTR_KEY,
} from '@temporalio/internal-non-workflow-common/lib/otel';
import {
  decompileRetryPolicy,
  optionalTsToDate,
  optionalTsToMs,
  SearchAttributes,
  tsToMs,
} from '@temporalio/internal-workflow-common';
import { coresdk, temporal } from '@temporalio/proto';
import { DeterminismViolationError, SinkCall, WorkflowInfo } from '@temporalio/workflow';
import crypto from 'crypto';
import fs from 'fs/promises';
import {
  BehaviorSubject,
  EMPTY,
  firstValueFrom,
  from,
  lastValueFrom,
  merge,
  MonoTypeOperatorFunction,
  Observable,
  OperatorFunction,
  pipe,
  race,
  Subject,
} from 'rxjs';
import { delay, filter, first, ignoreElements, last, map, mergeMap, takeUntil, takeWhile, tap } from 'rxjs/operators';
import { promisify } from 'util';
import { Activity, CancelReason } from './activity';
import { extractNativeClient, extractReferenceHolders, InternalNativeConnection, NativeConnection } from './connection';
import * as errors from './errors';
import { ActivityExecuteInput } from './interceptors';
import { Logger } from './logger';
import pkg from './pkg';
import { History, Runtime } from './runtime';
import { closeableGroupBy, mapWithState, mergeMapWithState } from './rxutils';
import { childSpan, getTracer, instrument } from './tracing';
import { byteArrayToBuffer, convertToParentWorkflowType, toMB } from './utils';
import {
  addDefaultWorkerOptions,
  CompiledWorkerOptions,
  compileWorkerOptions,
  isCodeBundleOption,
  isPathBundleOption,
  ReplayWorkerOptions,
  WorkerOptions,
} from './worker-options';
import { WorkflowCodecRunner } from './workflow-codec-runner';
import { WorkflowBundleWithSourceMap, WorkflowCodeBundler } from './workflow/bundler';
import { Workflow, WorkflowCreator } from './workflow/interface';
import { ThreadedVMWorkflowCreator } from './workflow/threaded-vm';
import { VMWorkflowCreator } from './workflow/vm';

import IWorkflowActivationJob = coresdk.workflow_activation.IWorkflowActivationJob;
import EvictionReason = coresdk.workflow_activation.RemoveFromCache.EvictionReason;
import IRemoveFromCache = coresdk.workflow_activation.IRemoveFromCache;

export { DataConverter, defaultPayloadConverter, errors };

native.registerErrors(errors);
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

type PatchJob = NonNullableObject<Pick<coresdk.workflow_activation.IWorkflowActivationJob, 'notifyHasPatch'>>;
type ContextAware<T> = T & {
  parentSpan: otel.Span;
};

export type ActivationWithContext = ContextAware<{
  activation: coresdk.workflow_activation.WorkflowActivation;
}>;
export type ActivityTaskWithContext = ContextAware<{
  task: coresdk.activity_task.ActivityTask;
  base64TaskToken: string;
}>;

export interface NativeWorkerLike {
  initiateShutdown: Promisify<OmitFirstParam<typeof native.workerInitiateShutdown>>;
  finalizeShutdown(): Promise<void>;
  flushCoreLogs(): void;
  pollWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerPollWorkflowActivation>>;
  pollActivityTask: Promisify<OmitFirstParam<typeof native.workerPollActivityTask>>;
  completeWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerCompleteWorkflowActivation>>;
  completeActivityTask: Promisify<OmitFirstParam<typeof native.workerCompleteActivityTask>>;
  recordActivityHeartbeat: OmitFirstParam<typeof native.workerRecordActivityHeartbeat>;
  logger: Logger;
}

export interface WorkerConstructor {
  create(
    connection: NativeConnection,
    options: CompiledWorkerOptions,
    bundle?: WorkflowBundleWithSourceMap
  ): Promise<NativeWorkerLike>;
  createReplay(
    options: CompiledWorkerOptions,
    history: History,
    bundle: WorkflowBundleWithSourceMap
  ): Promise<NativeWorkerLike>;
}

function isOptionsWithBuildId<T extends CompiledWorkerOptions>(options: T): options is T & { buildId: string } {
  return options.buildId != null;
}

function addBuildIdIfMissing<T extends CompiledWorkerOptions>(
  options: T,
  bundleCode?: string
): T & { buildId: string } {
  if (isOptionsWithBuildId(options)) {
    return options;
  }
  const suffix = bundleCode ? `+${crypto.createHash('sha256').update(bundleCode).digest('hex')}` : '';
  return { ...options, buildId: `${pkg.name}@${pkg.version}${suffix}` };
}

export class NativeWorker implements NativeWorkerLike {
  public readonly pollWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerPollWorkflowActivation>>;
  public readonly pollActivityTask: Promisify<OmitFirstParam<typeof native.workerPollActivityTask>>;
  public readonly completeWorkflowActivation: Promisify<OmitFirstParam<typeof native.workerCompleteWorkflowActivation>>;
  public readonly completeActivityTask: Promisify<OmitFirstParam<typeof native.workerCompleteActivityTask>>;
  public readonly recordActivityHeartbeat: OmitFirstParam<typeof native.workerRecordActivityHeartbeat>;
  public readonly initiateShutdown: Promisify<OmitFirstParam<typeof native.workerInitiateShutdown>>;

  public static async create(
    connection: NativeConnection,
    options: CompiledWorkerOptions,
    bundle?: WorkflowBundleWithSourceMap
  ): Promise<NativeWorkerLike> {
    const runtime = Runtime.instance();
    const nativeWorker = await runtime.registerWorker(
      extractNativeClient(connection),
      addBuildIdIfMissing(options, bundle?.code)
    );
    return new NativeWorker(runtime, nativeWorker);
  }

  public static async createReplay(
    options: CompiledWorkerOptions,
    history: History,
    bundle: WorkflowBundleWithSourceMap
  ): Promise<NativeWorkerLike> {
    const runtime = Runtime.instance();
    const nativeWorker = await runtime.createReplayWorker(addBuildIdIfMissing(options, bundle.code), history);
    return new NativeWorker(runtime, nativeWorker);
  }

  protected constructor(protected readonly runtime: Runtime, protected readonly nativeWorker: native.Worker) {
    this.pollWorkflowActivation = promisify(native.workerPollWorkflowActivation).bind(undefined, nativeWorker);
    this.pollActivityTask = promisify(native.workerPollActivityTask).bind(undefined, nativeWorker);
    this.completeWorkflowActivation = promisify(native.workerCompleteWorkflowActivation).bind(undefined, nativeWorker);
    this.completeActivityTask = promisify(native.workerCompleteActivityTask).bind(undefined, nativeWorker);
    this.recordActivityHeartbeat = native.workerRecordActivityHeartbeat.bind(undefined, nativeWorker);
    this.initiateShutdown = promisify(native.workerInitiateShutdown).bind(undefined, nativeWorker);
  }

  flushCoreLogs(): void {
    this.runtime.flushLogs();
  }

  public async finalizeShutdown(): Promise<void> {
    await this.runtime.deregisterWorker(this.nativeWorker);
  }

  public get logger(): Logger {
    return this.runtime.logger;
  }
}

function formatTaskToken(taskToken: Uint8Array) {
  return Buffer.from(taskToken).toString('base64');
}

/**
 * Notify that an activity has started, used as input to {@link Worker.activityHeartbeatSubject}
 *
 * Used to detect rouge activities.
 */
interface HeartbeatCreateNotification {
  type: 'create';
  base64TaskToken: string;
}

/**
 * Heartbeat request used as input to {@link Worker.activityHeartbeatSubject}
 */
interface Heartbeat {
  type: 'heartbeat';
  base64TaskToken: string;
  taskToken: Uint8Array;
  details?: any;
  onError: () => void;
}

/**
 * Notifies that an activity has been complete, used as input to {@link Worker.activityHeartbeatSubject}
 */
interface ActivityCompleteNotification {
  type: 'completion';
  flushRequired: boolean;
  callback(): void;
  base64TaskToken: string;
}

/**
 * Notifies that an Activity heartbeat has been flushed, used as input to {@link Worker.activityHeartbeatSubject}
 */
interface HeartbeatFlushNotification {
  type: 'flush';
  base64TaskToken: string;
}

/**
 * Input for the {@link Worker.activityHeartbeatSubject}
 */
type HeartbeatInput =
  | Heartbeat
  | ActivityCompleteNotification
  | HeartbeatFlushNotification
  | HeartbeatCreateNotification;

/**
 * State for managing a single Activity's heartbeat sending
 */
interface HeartbeatState {
  closed: boolean;
  processing: boolean;
  completionCallback?: () => void;
  pending?: Heartbeat;
}

/**
 * Request to send a heartbeat, used as output from the Activity heartbeat state mapper
 */
interface HeartbeatSendRequest {
  type: 'send';
  heartbeat: Heartbeat;
}

/**
 * Request to close an Activity heartbeat stream, used as output from the Activity heartbeat state mapper
 */
interface HeartbeatGroupCloseRequest {
  type: 'close';
  completionCallback?: () => void;
}

/**
 * Output from the Activity heartbeat state mapper
 */
type HeartbeatOutput = HeartbeatSendRequest | HeartbeatGroupCloseRequest;

/**
 * Used as the return type of the Activity heartbeat state mapper
 */
interface HeartbeatStateAndOutput {
  state: HeartbeatState;
  output: HeartbeatOutput | null;
}

export type PollerState = 'POLLING' | 'SHUTDOWN' | 'FAILED';

/**
 * Status overview of a Worker.
 * Useful for troubleshooting issues and overall obeservability.
 */
export interface WorkerStatus {
  /**
   * General run state of a Worker
   */
  runState: State;
  /**
   * General state of the Workflow poller
   */
  workflowPollerState: PollerState;
  /**
   * General state of the Activity poller
   */
  activityPollerState: PollerState;
  /**
   * Whether this Worker has an outstanding Workflow poll request
   */
  hasOutstandingWorkflowPoll: boolean;
  /**
   * Whether this Worker has an outstanding Activity poll request
   */
  hasOutstandingActivityPoll: boolean;

  /**
   * Number of in-flight (currently actively processed) Workflow activations
   */
  numInFlightWorkflowActivations: number;
  /**
   * Number of in-flight (currently actively processed) Activities
   */
  numInFlightActivities: number;
  /**
   * Number of Workflow executions cached in Worker memory
   */
  numCachedWorkflows: number;

  /**
   * Number of running Activities that have emitted a heartbeat
   */
  numHeartbeatingActivities: number;
}

/**
 * The temporal Worker connects to Temporal Server and runs Workflows and Activities.
 */
export class Worker {
  protected readonly activityHeartbeatSubject = new Subject<HeartbeatInput>();
  protected readonly unexpectedErrorSubject = new Subject<void>();
  protected readonly stateSubject = new BehaviorSubject<State>('INITIALIZED');

  protected readonly workflowPollerStateSubject = new BehaviorSubject<PollerState>('POLLING');
  protected readonly activityPollerStateSubject = new BehaviorSubject<PollerState>('POLLING');
  /**
   * Whether or not this worker has an outstanding workflow poll request
   */
  protected hasOutstandingWorkflowPoll = false;
  /**
   * Whether or not this worker has an outstanding activity poll request
   */
  protected hasOutstandingActivityPoll = false;

  protected readonly numInFlightActivationsSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly numCachedWorkflowsSubject = new BehaviorSubject<number>(0);
  protected readonly numHeartbeatingActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly evictionsSubject = new Subject<{ runId: string; evictJob: IRemoveFromCache }>();
  private readonly runIdsToSpanContext = new Map<string, SpanContext>();

  protected static nativeWorkerCtor: WorkerConstructor = NativeWorker;
  // Used to add uniqueness to replay worker task queue names
  protected static replayWorkerCount = 0;
  private static readonly SELF_INDUCED_SHUTDOWN_EVICTION: IRemoveFromCache = {
    message: 'Shutting down',
    reason: EvictionReason.FATAL,
  };
  protected readonly tracer: otel.Tracer;
  protected readonly workflowCodecRunner: WorkflowCodecRunner;

  /**
   * Create a new Worker.
   * This method initiates a connection to the server and will throw (asynchronously) on connection failure.
   */
  public static async create(options: WorkerOptions): Promise<Worker> {
    const nativeWorkerCtor: WorkerConstructor = this.nativeWorkerCtor;
    const compiledOptions = compileWorkerOptions(addDefaultWorkerOptions(options));
    const bundle = await this.getOrCreateBundle(compiledOptions, Runtime.instance().logger);
    let workflowCreator: WorkflowCreator | undefined = undefined;
    if (bundle) {
      workflowCreator = await this.createWorkflowCreator(bundle, compiledOptions);
    }
    // Create a new connection if one is not provided with no CREATOR reference
    // so it can be automatically closed when this Worker shuts down.
    const connection = options.connection ?? (await InternalNativeConnection.connect());
    let nativeWorker: NativeWorkerLike;
    try {
      nativeWorker = await nativeWorkerCtor.create(connection, compiledOptions);
    } catch (err) {
      // We just created this connection, close it
      if (!options.connection) {
        await connection.close();
      }
      throw err;
    }
    extractReferenceHolders(connection).add(nativeWorker);
    return new this(nativeWorker, workflowCreator, compiledOptions, connection);
  }

  protected static async createWorkflowCreator(
    bundle: WorkflowBundleWithSourceMap,
    compiledOptions: CompiledWorkerOptions
  ): Promise<WorkflowCreator> {
    if (compiledOptions.debugMode) {
      return await VMWorkflowCreator.create(bundle.code, bundle.sourceMap, compiledOptions.isolateExecutionTimeoutMs);
    } else {
      return await ThreadedVMWorkflowCreator.create({
        ...bundle,
        threadPoolSize: compiledOptions.workflowThreadPoolSize,
        isolateExecutionTimeoutMs: compiledOptions.isolateExecutionTimeoutMs,
      });
    }
  }

  /**
   * Create a replay Worker, and run the provided history against it. Will resolve as soon as
   * the history has finished being replayed, or if the workflow produces a nondeterminism error.
   *
   * @throws DeterminismViolationError if the workflow code is not compatible with the history.
   */
  public static async runReplayHistory(options: ReplayWorkerOptions, history: History): Promise<void> {
    const nativeWorkerCtor: WorkerConstructor = this.nativeWorkerCtor;
    const fixedUpOptions: WorkerOptions = {
      taskQueue: options.replayName + '-' + this.replayWorkerCount,
      debugMode: true,
      ...options,
    };
    this.replayWorkerCount += 1;
    const compiledOptions = compileWorkerOptions(addDefaultWorkerOptions(fixedUpOptions));
    const bundle = await this.getOrCreateBundle(compiledOptions, Runtime.instance().logger);
    if (!bundle) {
      throw new TypeError('ReplayWorkerOptions must contain workflowsPath or workflowBundle');
    }
    const workflowCreator = await this.createWorkflowCreator(bundle, compiledOptions);
    const replayWorker = await nativeWorkerCtor.createReplay(compiledOptions, history, bundle);
    const constructedWorker = new this(replayWorker, workflowCreator, compiledOptions);

    const runPromise = constructedWorker.run();
    const pollerShutdown = firstValueFrom(
      constructedWorker.workflowPollerStateSubject.pipe(filter((state) => state !== 'POLLING'))
    );

    const evictionPromise = firstValueFrom(
      constructedWorker.evictionsSubject.pipe(
        // Ignore self-induced shutdowns, as they are a legit and we'll terminate normally.
        filter(
          ({ evictJob }) =>
            evictJob.message !== this.SELF_INDUCED_SHUTDOWN_EVICTION.message &&
            evictJob.reason !== this.SELF_INDUCED_SHUTDOWN_EVICTION.reason
        ),
        map(({ evictJob }) => {
          if (evictJob.reason === EvictionReason.NONDETERMINISM) {
            throw new DeterminismViolationError(
              'Replay failed with a nondeterminism error. This means that the workflow code as written ' +
                `is not compatible with the history that was fed in. Details: ${evictJob.message}`
            );
          } else {
            throw new Error(`Replay failed. Details: ${evictJob.message}`);
          }
        })
      )
    );

    await Promise.race([runPromise, Promise.all([evictionPromise, pollerShutdown])]).finally(() => {
      try {
        constructedWorker.shutdown();
      } catch {
        // We may have already shut down and that's fine
      }
    });
  }

  protected static async getOrCreateBundle(
    compiledOptions: CompiledWorkerOptions,
    logger: Logger
  ): Promise<WorkflowBundleWithSourceMap | undefined> {
    if (compiledOptions.workflowsPath) {
      const bundler = new WorkflowCodeBundler({
        logger,
        workflowsPath: compiledOptions.workflowsPath,
        workflowInterceptorModules: compiledOptions.interceptors?.workflowModules,
        payloadConverterPath: compiledOptions.dataConverter?.payloadConverterPath,
        ignoreModules: compiledOptions.bundlerOptions?.ignoreModules,
      });
      const bundle = await bundler.createBundle();
      logger.info('Workflow bundle created', { size: `${toMB(bundle.code.length)}MB` });
      return bundle;
    } else if (compiledOptions.workflowBundle) {
      if (isCodeBundleOption(compiledOptions.workflowBundle)) {
        return compiledOptions.workflowBundle;
      } else if (isPathBundleOption(compiledOptions.workflowBundle)) {
        const [code, sourceMap] = await Promise.all([
          fs.readFile(compiledOptions.workflowBundle.codePath, 'utf8'),
          fs.readFile(compiledOptions.workflowBundle.sourceMapPath, 'utf8'),
        ]);
        return { code, sourceMap };
      } else {
        throw new TypeError('Invalid WorkflowOptions.workflowBundle');
      }
    } else {
      return undefined;
    }
  }

  /**
   * Create a new Worker from nativeWorker.
   */
  protected constructor(
    protected readonly nativeWorker: NativeWorkerLike,
    /**
     * Optional WorkflowCreator - if not provided, Worker will not poll on Workflows
     */
    protected readonly workflowCreator: WorkflowCreator | undefined,
    public readonly options: CompiledWorkerOptions,
    protected readonly connection?: NativeConnection
  ) {
    this.tracer = getTracer(options.enableSDKTracing);
    this.workflowCodecRunner = new WorkflowCodecRunner(options.loadedDataConverter.payloadCodecs);
  }

  /**
   * An Observable which emits each time the number of in flight activations changes
   */
  public get numInFlightActivations$(): Observable<number> {
    return this.numInFlightActivationsSubject;
  }

  /**
   * An Observable which emits each time the number of in flight Activity tasks changes
   */
  public get numInFlightActivities$(): Observable<number> {
    return this.numInFlightActivitiesSubject;
  }

  /**
   * An Observable which emits each time the number of cached workflows changes
   */
  public get numRunningWorkflowInstances$(): Observable<number> {
    return this.numCachedWorkflowsSubject;
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

  /**
   * Get a status overview of this Worker
   */
  public getStatus(): WorkerStatus {
    return {
      runState: this.state,
      numHeartbeatingActivities: this.numHeartbeatingActivitiesSubject.value,
      workflowPollerState: this.workflowPollerStateSubject.value,
      activityPollerState: this.activityPollerStateSubject.value,
      hasOutstandingWorkflowPoll: this.hasOutstandingWorkflowPoll,
      hasOutstandingActivityPoll: this.hasOutstandingActivityPoll,
      numCachedWorkflows: this.numCachedWorkflowsSubject.value,
      numInFlightWorkflowActivations: this.numInFlightActivationsSubject.value,
      numInFlightActivities: this.numInFlightActivitiesSubject.value,
    };
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
    this.nativeWorker
      .initiateShutdown()
      .then(() => {
        // Core may have already returned a ShutdownError to our pollers in which
        // case the state would transition to DRAINED
        if (this.state === 'STOPPING') {
          this.state = 'DRAINING';
        }
      })
      .catch((error) => this.unexpectedErrorSubject.error(error));
  }

  /**
   * An observable which completes when state becomes DRAINED or throws if state transitions to
   * STOPPING and remains that way for {@link this.options.shutdownGraceTimeMs}.
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
          } catch (err: any) {
            if (err.name === 'ShutdownError') {
              break;
            }
            throw err;
          }
        }
      })()
    );
  }

  /**
   * Process Activity tasks
   */
  protected activityOperator(): OperatorFunction<ActivityTaskWithContext, ContextAware<{ completion: Uint8Array }>> {
    return pipe(
      closeableGroupBy(({ base64TaskToken }) => base64TaskToken),
      mergeMap((group$) => {
        return merge(
          group$,
          this.activityPollerStateSubject.pipe(
            // Core has indicated that it will not return any more poll results, evict all cached WFs
            filter((state) => state !== 'POLLING'),
            first(),
            map((): ActivityTaskWithContext => {
              return {
                parentSpan: this.tracer.startSpan('activity.shutdown.evict'),
                task: coresdk.activity_task.ActivityTask.create({
                  // NOTE: taskToken and cancel reason are not sent here.
                  // We assume that if the task is cancelled with no reason it
                  // means that the worker is being shut down.
                  cancel: {},
                }),
                base64TaskToken: group$.key,
              };
            }),
            takeUntil(group$.pipe(last(undefined, null)))
          )
        ).pipe(
          mergeMapWithState(
            async (activity: Activity | undefined, { task, parentSpan, base64TaskToken }) => {
              const { taskToken, variant } = task;
              if (!variant) {
                throw new TypeError('Got an activity task without a "variant" attribute');
              }

              return await instrument(this.tracer, parentSpan, `activity.${variant}`, async (span) => {
                // We either want to return an activity result (for failures) or pass on the activity for running at a later stage
                // If cancel is requested we ignore the result of this function
                // We don't run the activity directly in this operator because we need to return the activity in the state
                // so it can be cancelled if requested
                let output:
                  | {
                      type: 'result';
                      result: coresdk.activity_result.IActivityExecutionResult;
                      parentSpan: otel.Span;
                    }
                  | { type: 'run'; activity: Activity; input: ActivityExecuteInput; parentSpan: otel.Span }
                  | { type: 'ignore'; parentSpan: otel.Span };
                switch (variant) {
                  case 'start': {
                    if (activity !== undefined) {
                      throw new IllegalStateError(
                        `Got start event for an already running activity: ${base64TaskToken}`
                      );
                    }
                    const info = await extractActivityInfo(
                      task,
                      false,
                      this.options.loadedDataConverter,
                      this.options.namespace
                    );

                    const { activityType } = info;
                    const fn = this.options.activities?.[activityType];
                    if (typeof fn !== 'function') {
                      output = {
                        type: 'result',
                        result: {
                          failed: {
                            failure: {
                              message: `Activity function ${activityType} is not registered on this Worker, available activities: ${JSON.stringify(
                                Object.keys(this.options.activities ?? {})
                              )}`,
                              applicationFailureInfo: { type: 'NotFoundError', nonRetryable: false },
                            },
                          },
                        },
                        parentSpan,
                      };
                      break;
                    }
                    let args: unknown[];
                    try {
                      args = await decodeArrayFromPayloads(this.options.loadedDataConverter, task.start?.input);
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
                                nonRetryable: false,
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
                    const activityId = info.activityId;
                    this.log.debug('Starting activity', { activityId, activityType });

                    activity = new Activity(
                      info,
                      fn,
                      this.options.loadedDataConverter,
                      (details) =>
                        this.activityHeartbeatSubject.next({
                          type: 'heartbeat',
                          taskToken,
                          base64TaskToken,
                          details,
                          onError() {
                            activity?.cancel('HEARTBEAT_DETAILS_CONVERSION_FAILED'); // activity must be defined
                          },
                        }),
                      { inbound: this.options.interceptors?.activityInbound }
                    );
                    output = { type: 'run', activity, input, parentSpan };
                    break;
                  }
                  case 'cancel': {
                    output = { type: 'ignore', parentSpan };
                    if (activity === undefined) {
                      this.log.error('Tried to cancel a non-existing activity', { taskToken: base64TaskToken });
                      span.setAttribute('found', false);
                      break;
                    }
                    // NOTE: activity will not be considered cancelled until it confirms cancellation (by throwing a CancelledFailure)
                    this.log.debug('Cancelling activity', { taskToken: base64TaskToken });
                    span.setAttribute('found', true);
                    const reason = task.cancel?.reason;
                    if (reason === undefined || reason === null) {
                      // Special case of Lang side cancellation during shutdown (see `activity.shutdown.evict` above)
                      activity.cancel('WORKER_SHUTDOWN');
                    } else {
                      activity.cancel(coresdk.activity_task.ActivityCancelReason[reason] as CancelReason);
                    }
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
            const { base64TaskToken } = output.activity.info;

            this.activityHeartbeatSubject.next({
              type: 'create',
              base64TaskToken,
            });

            return await instrument(this.tracer, output.parentSpan, 'activity.run', async (span) => {
              let result;

              this.numInFlightActivitiesSubject.next(this.numInFlightActivitiesSubject.value + 1);
              try {
                result = await output.activity.run(output.input);
              } finally {
                this.numInFlightActivitiesSubject.next(this.numInFlightActivitiesSubject.value - 1);
                group$.close();
              }
              const status = result.failed ? 'failed' : result.completed ? 'completed' : 'cancelled';
              span.setAttributes({ status });

              if (status === 'failed') {
                // Make sure to flush the last heartbeat
                this.log.debug('Activity failed, waiting for heartbeats to be flushed', {
                  activityId: output.activity.info.activityId,
                  status,
                });
                await new Promise<void>((resolve) => {
                  this.activityHeartbeatSubject.next({
                    type: 'completion',
                    flushRequired: true,
                    base64TaskToken,
                    callback: resolve,
                  });
                });
              } else {
                // Notify the Activity heartbeat state mapper that the Activity has completed
                this.activityHeartbeatSubject.next({
                  type: 'completion',
                  flushRequired: false,
                  base64TaskToken,
                  callback: () => undefined,
                });
              }
              this.log.debug('Activity resolved', {
                activityId: output.activity.info.activityId,
                status,
              });
              return { taskToken, result, parentSpan: output.parentSpan };
            });
          }),
          filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
          map(({ parentSpan, ...rest }) => ({
            completion: coresdk.ActivityTaskCompletion.encodeDelimited(rest).finish(),
            parentSpan,
          }))
        );
      })
    );
  }

  /**
   * Process Workflow activations
   */
  protected workflowOperator(): OperatorFunction<ActivationWithContext, ContextAware<{ completion: Uint8Array }>> {
    const { workflowCreator } = this;
    if (workflowCreator === undefined) {
      throw new IllegalStateError('Cannot process workflows without an IsolateContextProvider');
    }
    interface WorkflowWithInfo {
      workflow: Workflow;
      info: WorkflowInfo;
    }
    return pipe(
      closeableGroupBy(({ activation }) => activation.runId),
      mergeMap((group$) => {
        return merge(
          group$.pipe(map((act) => ({ ...act, synthetic: false }))),
          this.workflowPollerStateSubject.pipe(
            // Core has indicated that it will not return any more poll results, evict all cached WFs
            filter((state) => state !== 'POLLING'),
            first(),
            map((): ContextAware<{ activation: coresdk.workflow_activation.WorkflowActivation; synthetic: true }> => {
              return {
                parentSpan: this.tracer.startSpan('workflow.shutdown.evict'),
                activation: coresdk.workflow_activation.WorkflowActivation.create({
                  runId: group$.key,
                  jobs: [{ removeFromCache: Worker.SELF_INDUCED_SHUTDOWN_EVICTION }],
                }),
                synthetic: true,
              };
            }),
            takeUntil(group$.pipe(last(undefined, null)))
          )
        ).pipe(
          tap(() => {
            this.numInFlightActivationsSubject.next(this.numInFlightActivationsSubject.value + 1);
          }),
          mergeMapWithState(
            async (
              state: WorkflowWithInfo | undefined,
              { activation, parentSpan, synthetic }
            ): Promise<{
              state: WorkflowWithInfo | undefined;
              output: ContextAware<{ completion?: Uint8Array; close: boolean }>;
            }> => {
              try {
                return await instrument(this.tracer, parentSpan, 'workflow.process', async (span) => {
                  span.setAttributes({
                    numInFlightActivations: this.numInFlightActivationsSubject.value,
                    numCachedWorkflows: this.numCachedWorkflowsSubject.value,
                  });
                  const removeFromCacheIx = activation.jobs.findIndex(({ removeFromCache }) => removeFromCache);
                  const close = removeFromCacheIx !== -1;
                  const jobs = activation.jobs;
                  if (close) {
                    const asEvictJob = jobs.splice(removeFromCacheIx, 1)[0].removeFromCache;
                    if (asEvictJob) {
                      this.evictionsSubject.next({
                        runId: activation.runId,
                        evictJob: asEvictJob,
                      });
                    }
                  }
                  activation.jobs = jobs;
                  if (jobs.length === 0) {
                    state?.workflow.dispose();
                    if (!close) {
                      const message = 'Got a Workflow activation with no jobs';
                      throw new IllegalStateError(message);
                    }
                    this.log.debug('Disposing workflow', { runId: activation.runId });
                    const completion = synthetic
                      ? undefined
                      : coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited({
                          runId: activation.runId,
                          successful: {},
                        }).finish();
                    return { state: undefined, output: { close, completion, parentSpan } };
                  }

                  if (state === undefined) {
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
                      if (activation.timestamp == null) {
                        throw new TypeError('Got activation with no timestamp, cannot create a new Workflow instance');
                      }
                      const {
                        workflowId,
                        randomnessSeed,
                        workflowType,
                        parentWorkflowInfo,
                        workflowExecutionTimeout,
                        workflowRunTimeout,
                        workflowTaskTimeout,
                        continuedFromExecutionRunId,
                        continuedFailure,
                        lastCompletionResult,
                        firstExecutionRunId,
                        retryPolicy,
                        attempt,
                        cronSchedule,
                        workflowExecutionExpirationTime,
                        cronScheduleToScheduleInterval,
                        memo,
                        searchAttributes,
                      } = startWorkflow;

                      if (firstExecutionRunId === null || firstExecutionRunId === undefined) {
                        throw new TypeError(`Unexpected value: \`firstExecutionRunId\` is ${firstExecutionRunId}`);
                      }
                      if (attempt === null || attempt === undefined) {
                        throw new TypeError(`Unexpected value: \`attempt\` is ${attempt}`);
                      }
                      this.log.debug('Creating workflow', {
                        workflowType,
                        workflowId,
                        runId: activation.runId,
                      });
                      this.numCachedWorkflowsSubject.next(this.numCachedWorkflowsSubject.value + 1);
                      const workflowInfo: WorkflowInfo = {
                        workflowId,
                        runId: activation.runId,
                        workflowType,
                        searchAttributes: mapFromPayloads(
                          searchAttributePayloadConverter,
                          searchAttributes?.indexedFields
                        ) as SearchAttributes | undefined,
                        memo: await decodeMapFromPayloads(this.options.loadedDataConverter, memo?.fields),
                        parent: convertToParentWorkflowType(parentWorkflowInfo),
                        lastResult: await decodeFromPayloadsAtIndex(
                          this.options.loadedDataConverter,
                          0,
                          lastCompletionResult?.payloads
                        ),
                        lastFailure: await decodeOptionalFailureToOptionalError(
                          this.options.loadedDataConverter,
                          continuedFailure
                        ),
                        taskQueue: this.options.taskQueue,
                        namespace: this.options.namespace,
                        firstExecutionRunId,
                        continuedFromExecutionRunId: continuedFromExecutionRunId || undefined,
                        executionTimeoutMs: optionalTsToMs(workflowExecutionTimeout),
                        executionExpirationTime: optionalTsToDate(workflowExecutionExpirationTime),
                        runTimeoutMs: optionalTsToMs(workflowRunTimeout),
                        taskTimeoutMs: tsToMs(workflowTaskTimeout),
                        retryPolicy: decompileRetryPolicy(retryPolicy),
                        attempt,
                        cronSchedule: cronSchedule || undefined,
                        // 0 is the default, and not a valid value, since crons are at least a minute apart
                        cronScheduleToScheduleInterval: optionalTsToMs(cronScheduleToScheduleInterval) || undefined,
                      };
                      const patchJobs = activation.jobs.filter((j): j is PatchJob => j.notifyHasPatch != null);
                      const patches = patchJobs.map(({ notifyHasPatch }) => {
                        const { patchId } = notifyHasPatch;
                        if (!patchId) {
                          throw new TypeError('Got a patch without a patchId');
                        }
                        return patchId;
                      });

                      const workflow = await instrument(this.tracer, span, 'workflow.create', async () => {
                        return await workflowCreator.createWorkflow({
                          info: workflowInfo,
                          randomnessSeed: randomnessSeed.toBytes(),
                          now: tsToMs(activation.timestamp),
                          patches,
                          isReplaying: activation.isReplaying,
                          historyLength: activation.historyLength,
                        });
                      });
                      state = { workflow, info: workflowInfo };
                    } else {
                      throw new IllegalStateError(
                        'Received workflow activation for an untracked workflow with no start workflow job'
                      );
                    }
                  }

                  let isFatalError = false;
                  try {
                    const decodedActivation = await this.workflowCodecRunner.decodeActivation(activation);
                    const unencodedCompletion = await state.workflow.activate(decodedActivation);
                    const completion = await this.workflowCodecRunner.encodeCompletion(unencodedCompletion);
                    this.log.debug('Completed activation', {
                      runId: activation.runId,
                    });

                    span.setAttribute('close', close).end();
                    return { state, output: { close, completion, parentSpan } };
                  } catch (err) {
                    if (err instanceof errors.UnexpectedError) {
                      isFatalError = true;
                    }
                    throw err;
                  } finally {
                    // Fatal error means we cannot call into this workflow again unfortunately
                    if (!isFatalError) {
                      const externalCalls = await state.workflow.getAndResetSinkCalls();
                      // TODO: state.info.searchAttributes are not updated here
                      await this.processSinkCalls(externalCalls, state.info, activation.isReplaying);
                    }
                  }
                });
              } catch (error) {
                if (error instanceof errors.UnexpectedError) {
                  // rethrow and fail the worker
                  throw error;
                }
                this.log.error('Failed to activate workflow', {
                  runId: activation.runId,
                  error,
                  workflowExists: state !== undefined,
                });
                const completion = coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited({
                  runId: activation.runId,
                  failed: {
                    failure: await encodeErrorToFailure(this.options.loadedDataConverter, error),
                  },
                }).finish();
                // We do not dispose of the Workflow yet, wait to be evicted from Core.
                // This is done to simplify the Workflow lifecycle so Core is the sole driver.
                return { state: undefined, output: { close: true, completion, parentSpan } };
              }
            },
            undefined
          ),
          tap(({ close }) => {
            this.numInFlightActivationsSubject.next(this.numInFlightActivationsSubject.value - 1);
            if (close) {
              group$.close();
              this.runIdsToSpanContext.delete(group$.key);
              this.numCachedWorkflowsSubject.next(this.numCachedWorkflowsSubject.value - 1);
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
   * Process extracted external calls from Workflow post activation.
   *
   * Each SinkCall is translated into a injected sink function call.
   *
   * This function does not throw, it will log in case of missing sinks
   * or failed sink function invocations.
   */
  protected async processSinkCalls(externalCalls: SinkCall[], info: WorkflowInfo, isReplaying: boolean): Promise<void> {
    const { sinks } = this.options;
    await Promise.all(
      externalCalls.map(async ({ ifaceName, fnName, args }) => {
        const dep = sinks?.[ifaceName]?.[fnName];
        if (dep === undefined) {
          this.log.error('Workflow referenced an unregistered external sink', {
            ifaceName,
            fnName,
          });
        } else if (dep.callDuringReplay || !isReplaying) {
          try {
            await dep.fn(info, ...args);
          } catch (error) {
            this.log.error('External sink function threw an error', {
              ifaceName,
              fnName,
              error,
              workflowInfo: info,
            });
          }
        }
      })
    );
  }

  /**
   * Listen on heartbeats emitted from activities and send them to core.
   * Errors from core responses are translated to cancellation requests and fed back via the activityFeedbackSubject.
   */
  protected activityHeartbeat$(): Observable<void> {
    function process(state: HeartbeatState, heartbeat: Heartbeat): HeartbeatStateAndOutput {
      return { state: { ...state, processing: true, pending: undefined }, output: { type: 'send', heartbeat } };
    }

    function storePending(state: HeartbeatState, heartbeat: Heartbeat): HeartbeatStateAndOutput {
      return { state: { ...state, pending: heartbeat }, output: null };
    }

    function complete(callback: () => void): HeartbeatStateAndOutput {
      return {
        state: { pending: undefined, completionCallback: undefined, processing: false, closed: true },
        output: { type: 'close', completionCallback: callback },
      };
    }

    return this.activityHeartbeatSubject.pipe(
      // The only way for this observable to be closed is by state changing to DRAINED meaning that all in-flight activities have been resolved and thus there should not be any heartbeats to send.
      this.takeUntilState('DRAINED'),
      tap({
        next: ({ base64TaskToken }) => this.log.trace('Got activity heartbeat', { taskToken: base64TaskToken }),
        complete: () => this.log.debug('Heartbeats complete'),
      }),
      closeableGroupBy(({ base64TaskToken }) => base64TaskToken),
      mergeMap((group$) =>
        group$.pipe(
          mapWithState(
            (state: HeartbeatState, input: HeartbeatInput): HeartbeatStateAndOutput => {
              if (input.type === 'create') {
                this.numHeartbeatingActivitiesSubject.next(this.numHeartbeatingActivitiesSubject.value + 1);
                return { state: { processing: false, closed: false }, output: null };
              }
              // Ignore any input if we've marked this activity heartbeat stream as closed
              // (rogue heartbeat)
              if (state.closed) return { state, output: { type: 'close' } };

              switch (input.type) {
                case 'heartbeat':
                  if (state.processing) {
                    // We're already processing a heartbeat, mark this one as pending
                    return storePending(state, input);
                  } else {
                    // Ready to send heartbeat, mark that we're now processing
                    return process(state, input);
                  }
                case 'flush':
                  if (state.pending) {
                    // Send pending heartbeat
                    return process(state, state.pending);
                  } else if (state.completionCallback) {
                    // We were asked to complete, fulfill that request
                    return complete(state.completionCallback);
                  } else {
                    // Nothing to do, wait for completion or heartbeat
                    return { state: { ...state, processing: false }, output: null };
                  }
                case 'completion':
                  if (state.processing) {
                    // Store the completion callback until heartbeat has been flushed
                    return {
                      state: {
                        ...state,
                        // If flush isn't required, delete any pending heartbeat
                        pending: input.flushRequired ? state.pending : undefined,
                        completionCallback: input.callback,
                      },
                      output: null,
                    };
                  } else if (!input.flushRequired) {
                    return complete(input.callback);
                  } else {
                    if (state.pending) {
                      // Flush the final heartbeat and store the completion callback
                      return process({ ...state, completionCallback: input.callback }, state.pending);
                    } else {
                      // Nothing to flush, complete and call back
                      return complete(input.callback);
                    }
                  }
              }
            },
            // Start `closed`, wait for a `create` input to open the stream.
            // This prevents rogue activities from heartbeating and keeping
            // this stream open.
            { processing: false, closed: true }
          ),
          filter((out): out is HeartbeatOutput => out != null),
          tap((out) => {
            if (out.type === 'close') {
              this.numHeartbeatingActivitiesSubject.next(this.numHeartbeatingActivitiesSubject.value - 1);
              out.completionCallback?.();
            }
          }),
          takeWhile((out): out is HeartbeatSendRequest => out.type !== 'close'),
          mergeMap(async ({ heartbeat: { base64TaskToken, taskToken, details, onError } }) => {
            let payload: Payload;
            try {
              try {
                payload = await encodeToPayload(this.options.loadedDataConverter, details);
              } catch (error: any) {
                this.log.warn('Failed to encode heartbeat details, cancelling Activity', {
                  error,
                  taskToken: base64TaskToken,
                });
                onError();
                return;
              }
              const arr = coresdk.ActivityHeartbeat.encodeDelimited({
                taskToken,
                details: [payload],
              }).finish();
              this.nativeWorker.recordActivityHeartbeat(byteArrayToBuffer(arr));
            } finally {
              this.activityHeartbeatSubject.next({ type: 'flush', base64TaskToken });
            }
          }),
          tap({ complete: group$.close })
        )
      )
    );
  }

  /**
   * Poll core for `WorkflowActivation`s while respecting worker state.
   */
  protected workflowPoll$(): Observable<ActivationWithContext> {
    return this.pollLoop$(async () => {
      const parentSpan = this.tracer.startSpan('workflow.activation');
      return await instrument(
        this.tracer,
        parentSpan,
        'workflow.poll',
        async (span) => {
          this.hasOutstandingWorkflowPoll = true;
          let buffer: ArrayBuffer;
          try {
            buffer = await this.nativeWorker.pollWorkflowActivation(span.spanContext());
          } finally {
            this.hasOutstandingWorkflowPoll = false;
          }
          const activation = coresdk.workflow_activation.WorkflowActivation.decode(new Uint8Array(buffer));
          const { runId, ...rest } = activation;
          this.log.debug('Got workflow activation', { runId, ...rest });

          span.setAttribute(RUN_ID_ATTR_KEY, runId).setAttribute(NUM_JOBS_ATTR_KEY, rest.jobs.length);
          await this.linkWorkflowSpans(runId, rest.jobs, parentSpan);

          return { activation, parentSpan };
        },
        (err) => err instanceof Error && err.name === 'ShutdownError'
      );
    }).pipe(
      tap({
        complete: () => {
          this.workflowPollerStateSubject.next('SHUTDOWN');
        },
        error: () => {
          this.workflowPollerStateSubject.next('FAILED');
        },
      })
    );
  }

  /**
   * Given a run ID, some jobs from a new WFT, and the parent span or the workflow activation,
   * handle linking any span context that exists in the WF headers to our internal spans.
   *
   * The result here is that our SDK spans in node and core are separate from the user's spans
   * that they create when they use interceptors, with our spans being linked to theirs.
   *
   * If the activation includes WF start, headers will be extracted and cached. If it does not,
   * any previously such extracted header will be used for the run.
   */
  private async linkWorkflowSpans(runId: string, jobs: IWorkflowActivationJob[], parentSpan: otel.Span) {
    let linkedContext = this.runIdsToSpanContext.get(runId);
    // If there is an otel context in the headers, link our trace for the workflow to the
    // trace in the header.
    for (const j of jobs) {
      if (j.startWorkflow != null) {
        const ctx = await extractSpanContextFromHeaders(j.startWorkflow.headers ?? {});
        if (ctx !== undefined && linkedContext === undefined) {
          this.runIdsToSpanContext.set(runId, ctx);
          linkedContext = ctx;
        }
      }
    }
    if (linkedContext != null) {
      linkSpans(parentSpan, linkedContext);
    }
  }

  /**
   * Poll for Workflow activations, handle them, and report completions.
   */
  protected workflow$(): Observable<void> {
    // This Worker did not register any workflows, return early
    if (this.workflowCreator === undefined) {
      this.workflowPollerStateSubject.next('SHUTDOWN');
      return EMPTY;
    }
    return this.workflowPoll$().pipe(
      this.workflowOperator(),
      mergeMap(async ({ completion, parentSpan: root }) => {
        const span = childSpan(this.tracer, root, 'workflow.complete');
        try {
          await this.nativeWorker.completeWorkflowActivation(
            span.spanContext(),
            completion.buffer.slice(completion.byteOffset)
          );
          span.setStatus({ code: otel.SpanStatusCode.OK });
        } catch (err) {
          span.setStatus({ code: otel.SpanStatusCode.ERROR, message: errorMessage(err) });
          throw err;
        } finally {
          span.end();
          root.end();
        }
      }),
      tap({
        complete: () => {
          this.log.debug('Workflows complete');
        },
      })
    );
  }

  /**
   * Poll core for `ActivityTask`s while respecting worker state
   */
  protected activityPoll$(): Observable<ActivityTaskWithContext> {
    return this.pollLoop$(async () => {
      const parentSpan = this.tracer.startSpan('activity.task');
      return await instrument(
        this.tracer,
        parentSpan,
        'activity.poll',
        async (span) => {
          this.hasOutstandingActivityPoll = true;
          let buffer: ArrayBuffer;
          try {
            buffer = await this.nativeWorker.pollActivityTask(span.spanContext());
          } finally {
            this.hasOutstandingActivityPoll = false;
          }
          const task = coresdk.activity_task.ActivityTask.decode(new Uint8Array(buffer));
          const { taskToken, ...rest } = task;
          const base64TaskToken = formatTaskToken(taskToken);
          this.log.debug('Got activity task', { taskToken: base64TaskToken, ...rest });
          const { variant } = task;
          if (variant === undefined) {
            throw new TypeError('Got an activity task without a "variant" attribute');
          }
          parentSpan.setAttributes({
            [TASK_TOKEN_ATTR_KEY]: base64TaskToken,
            variant,
            [RUN_ID_ATTR_KEY]: task.start?.workflowExecution?.runId ?? 'unknown',
          });
          // If the activity had otel headers, link to that span
          if (task.start?.headerFields) {
            const ctx = await extractSpanContextFromHeaders(task.start.headerFields);
            linkSpans(parentSpan, ctx);
          }
          return { task, parentSpan, base64TaskToken };
        },
        (err) => err instanceof Error && err.name === 'ShutdownError'
      );
    }).pipe(
      tap({
        complete: () => {
          this.activityPollerStateSubject.next('SHUTDOWN');
        },
        error: () => {
          this.activityPollerStateSubject.next('FAILED');
        },
      })
    );
  }

  protected activity$(): Observable<void> {
    // Note that we poll on activities even if there are no activities registered.
    // This is so workflows invoking activities on this task queue get a non-retryable error.
    return this.activityPoll$().pipe(
      this.activityOperator(),
      mergeMap(async ({ completion, parentSpan }) => {
        try {
          await instrument(this.tracer, parentSpan, 'activity.complete', () =>
            this.nativeWorker.completeActivityTask(
              parentSpan.spanContext(),
              completion.buffer.slice(completion.byteOffset)
            )
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

  /**
   * {@link run | Run} the Worker until `fnOrPromise` completes.
   *
   * @returns the result of `fnOrPromise`
   *
   * Throws on fatal Worker errors.
   */
  async runUntil<R>(fnOrPromise: Promise<R> | (() => Promise<R>)): Promise<R> {
    const runAndShutdown = async () => {
      try {
        if (typeof fnOrPromise === 'function') {
          return await fnOrPromise();
        } else {
          return await fnOrPromise;
        }
      } finally {
        this.shutdown();
      }
    };
    const [_, ret] = await Promise.all([this.run(), runAndShutdown()]);
    return ret;
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
      throw new IllegalStateError('Poller was already started');
    }
    this.state = 'RUNNING';

    const shutdownCallback = () => this.shutdown();
    Runtime.instance().registerShutdownSignalCallback(shutdownCallback);

    try {
      try {
        await lastValueFrom(
          merge(
            this.unexpectedErrorSubject.pipe(takeUntil(this.stateSubject.pipe(filter((st) => st === 'DRAINED')))),
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
        Runtime.instance().deregisterShutdownSignalCallback(shutdownCallback);
      }
      // Only shutdown the native worker if we completed without an error.
      // Otherwise Rust / TS are in an unknown state and shutdown might hang.
      // A new process must be created in order to instantiate a new Rust Core.
      // TODO: force shutdown in core?
      await this.nativeWorker.finalizeShutdown();
    } finally {
      try {
        // Only exists in non-replay Worker
        if (this.connection) {
          extractReferenceHolders(this.connection).delete(this.nativeWorker);
          // Only close if this worker is the creator of the connection
          if (this.connection instanceof InternalNativeConnection) {
            await this.connection.close();
          }
        }
        await this.workflowCreator?.destroy();
      } finally {
        this.nativeWorker.flushCoreLogs();
      }
    }
  }
}

type NonNullableObject<T> = { [P in keyof T]-?: NonNullable<T[P]> };

/**
 * Transform an ActivityTask into ActivityInfo to pass on into an Activity
 */
async function extractActivityInfo(
  task: coresdk.activity_task.IActivityTask,
  isLocal: boolean,
  dataConverter: LoadedDataConverter,
  activityNamespace: string
): Promise<ActivityInfo> {
  // NOTE: We trust core to supply all of these fields instead of checking for null and undefined everywhere
  const { taskToken } = task as NonNullableObject<coresdk.activity_task.IActivityTask>;
  const start = task.start as NonNullableObject<coresdk.activity_task.IStart>;
  const activityId = start.activityId;
  return {
    taskToken,
    base64TaskToken: formatTaskToken(taskToken),
    activityId,
    workflowExecution: start.workflowExecution as NonNullableObject<temporal.api.common.v1.WorkflowExecution>,
    attempt: start.attempt,
    isLocal,
    activityType: start.activityType,
    workflowType: start.workflowType,
    heartbeatDetails: await decodeFromPayloadsAtIndex(dataConverter, 0, start.heartbeatDetails),
    activityNamespace,
    workflowNamespace: start.workflowNamespace,
    scheduledTimestampMs: tsToMs(start.scheduledTime),
    startToCloseTimeoutMs: tsToMs(start.startToCloseTimeout),
    scheduleToCloseTimeoutMs: optionalTsToMs(start.scheduleToCloseTimeout),
  };
}
