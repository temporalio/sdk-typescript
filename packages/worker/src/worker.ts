import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { EventEmitter, on } from 'node:events';
import { setTimeout as setTimeoutCallback } from 'node:timers';
import {
  BehaviorSubject,
  EMPTY,
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
import type { RawSourceMap } from 'source-map';
import * as nexus from 'nexus-rpc';
import { Info as ActivityInfo } from '@temporalio/activity';
import {
  DataConverter,
  decompileRetryPolicy,
  defaultPayloadConverter,
  IllegalStateError,
  LoadedDataConverter,
  SdkComponent,
  Payload,
  ApplicationFailure,
  ensureApplicationFailure,
  TypedSearchAttributes,
  decodePriority,
  CancelledFailure,
  MetricMeter,
  ActivityCancellationDetails,
} from '@temporalio/common';
import {
  decodeArrayFromPayloads,
  Decoded,
  decodeFromPayloadsAtIndex,
  encodeErrorToFailure,
  encodeToPayload,
} from '@temporalio/common/lib/internal-non-workflow';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import {
  Duration,
  msToNumber,
  optionalTsToDate,
  optionalTsToMs,
  requiredTsToMs,
  tsToDate,
  tsToMs,
} from '@temporalio/common/lib/time';
import { LoggerWithComposedMetadata } from '@temporalio/common/lib/logger';
import { errorMessage, NonNullableObject, OmitFirstParam } from '@temporalio/common/lib/type-helpers';
import { workflowLogAttributes } from '@temporalio/workflow/lib/logs';
import { native } from '@temporalio/core-bridge';
import { Client } from '@temporalio/client';
import { coresdk, temporal } from '@temporalio/proto';
import { type SinkCall, type WorkflowInfo } from '@temporalio/workflow';
import { throwIfReservedName } from '@temporalio/common/lib/reserved';
import { Activity, CancelReason, activityLogAttributes } from './activity';
import { extractNativeClient, extractReferenceHolders, InternalNativeConnection, NativeConnection } from './connection';
import { ActivityExecuteInput } from './interceptors';
import { Logger } from './logger';
import pkg from './pkg';
import {
  EvictionReason,
  evictionReasonToReplayError,
  RemoveFromCache,
  ReplayHistoriesIterable,
  ReplayResult,
} from './replay';
import { History, Runtime } from './runtime';
import { CloseableGroupedObservable, closeableGroupBy, mapWithState, mergeMapWithState } from './rxutils';
import {
  byteArrayToBuffer,
  convertDeploymentVersion,
  convertToParentWorkflowType,
  convertToRootWorkflowType,
} from './utils';
import {
  CompiledWorkerOptions,
  CompiledWorkerOptionsWithBuildId,
  compileWorkerOptions,
  isCodeBundleOption,
  isPathBundleOption,
  ReplayWorkerOptions,
  toNativeWorkerOptions,
  WorkerOptions,
  WorkflowBundle,
} from './worker-options';
import { WorkflowCodecRunner } from './workflow-codec-runner';
import { defaultWorkflowInterceptorModules, WorkflowCodeBundler } from './workflow/bundler';
import { Workflow, WorkflowCreator } from './workflow/interface';
import { ReusableVMWorkflowCreator } from './workflow/reusable-vm';
import { ThreadedVMWorkflowCreator } from './workflow/threaded-vm';
import { VMWorkflowCreator } from './workflow/vm';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow/workflow-worker-thread/input';
import {
  CombinedWorkerRunError,
  GracefulShutdownPeriodExpiredError,
  PromiseCompletionTimeoutError,
  ShutdownError,
  UnexpectedError,
} from './errors';
import { constructNexusOperationContext, NexusHandler } from './nexus';
import { handlerErrorToProto } from './nexus/conversions';

export { DataConverter, defaultPayloadConverter };

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

type WorkflowActivation = coresdk.workflow_activation.WorkflowActivation;

export type ActivityTaskWithBase64Token = {
  task: coresdk.activity_task.ActivityTask;
  base64TaskToken: string;

  // The unaltered protobuf-encoded ActivityTask; kept so that it can be printed
  // out for analysis if decoding fails at a later step.
  protobufEncodedTask: Buffer;
};

export type NexusTaskWithBase64Token = {
  task: coresdk.nexus.NexusTask;
  base64TaskToken: string;

  // The unaltered protobuf-encoded NexusTask; kept so that it can be printed
  // out for analysis if decoding fails at a later step.
  protobufEncodedTask: Buffer;
};

interface EvictionWithRunID {
  runId: string;
  evictJob: coresdk.workflow_activation.IRemoveFromCache;
}

export interface NativeWorkerLike {
  type: 'worker';
  initiateShutdown: OmitFirstParam<typeof native.workerInitiateShutdown>;
  finalizeShutdown(): Promise<void>;
  flushCoreLogs(): void;
  pollWorkflowActivation: OmitFirstParam<typeof native.workerPollWorkflowActivation>;
  pollActivityTask: OmitFirstParam<typeof native.workerPollActivityTask>;
  pollNexusTask: OmitFirstParam<typeof native.workerPollNexusTask>;
  completeWorkflowActivation: OmitFirstParam<typeof native.workerCompleteWorkflowActivation>;
  completeActivityTask: OmitFirstParam<typeof native.workerCompleteActivityTask>;
  completeNexusTask: OmitFirstParam<typeof native.workerCompleteNexusTask>;
  recordActivityHeartbeat: OmitFirstParam<typeof native.workerRecordActivityHeartbeat>;
}

export interface NativeReplayHandle {
  worker: NativeWorkerLike;
  historyPusher: native.HistoryPusher;
}

interface NativeWorkerConstructor {
  create(
    runtime: Runtime,
    connection: NativeConnection,
    options: CompiledWorkerOptionsWithBuildId
  ): Promise<NativeWorkerLike>;
  createReplay(runtime: Runtime, options: CompiledWorkerOptionsWithBuildId): Promise<NativeReplayHandle>;
}

interface WorkflowWithLogAttributes {
  workflow: Workflow;
  logAttributes: Record<string, unknown>;
}

function addBuildIdIfMissing(options: CompiledWorkerOptions, bundleCode?: string): CompiledWorkerOptionsWithBuildId {
  const bid = options.buildId; // eslint-disable-line deprecation/deprecation
  if (bid != null) {
    return options as CompiledWorkerOptionsWithBuildId;
  }
  const suffix = bundleCode ? `+${crypto.createHash('sha256').update(bundleCode).digest('hex')}` : '';
  return { ...options, buildId: `${pkg.name}@${pkg.version}${suffix}` };
}

export class NativeWorker implements NativeWorkerLike {
  public readonly type = 'worker';
  public readonly pollWorkflowActivation: OmitFirstParam<typeof native.workerPollWorkflowActivation>;
  public readonly pollActivityTask: OmitFirstParam<typeof native.workerPollActivityTask>;
  public readonly pollNexusTask: OmitFirstParam<typeof native.workerPollNexusTask>;
  public readonly completeWorkflowActivation: OmitFirstParam<typeof native.workerCompleteWorkflowActivation>;
  public readonly completeActivityTask: OmitFirstParam<typeof native.workerCompleteActivityTask>;
  public readonly completeNexusTask: OmitFirstParam<typeof native.workerCompleteNexusTask>;
  public readonly recordActivityHeartbeat: OmitFirstParam<typeof native.workerRecordActivityHeartbeat>;
  public readonly initiateShutdown: OmitFirstParam<typeof native.workerInitiateShutdown>;

  public static async create(
    runtime: Runtime,
    connection: NativeConnection,
    options: CompiledWorkerOptionsWithBuildId
  ): Promise<NativeWorkerLike> {
    const nativeWorker = await runtime.registerWorker(extractNativeClient(connection), toNativeWorkerOptions(options));
    return new NativeWorker(runtime, nativeWorker);
  }

  public static async createReplay(
    runtime: Runtime,
    options: CompiledWorkerOptionsWithBuildId
  ): Promise<NativeReplayHandle> {
    const [worker, historyPusher] = await runtime.createReplayWorker(toNativeWorkerOptions(options));
    return {
      worker: new NativeWorker(runtime, worker),
      historyPusher,
    };
  }

  protected constructor(
    protected readonly runtime: Runtime,
    protected readonly nativeWorker: native.Worker
  ) {
    this.pollWorkflowActivation = native.workerPollWorkflowActivation.bind(undefined, nativeWorker);
    this.pollActivityTask = native.workerPollActivityTask.bind(undefined, nativeWorker);
    this.pollNexusTask = native.workerPollNexusTask.bind(undefined, nativeWorker);
    this.completeWorkflowActivation = native.workerCompleteWorkflowActivation.bind(undefined, nativeWorker);
    this.completeActivityTask = native.workerCompleteActivityTask.bind(undefined, nativeWorker);
    this.completeNexusTask = native.workerCompleteNexusTask.bind(undefined, nativeWorker);
    this.recordActivityHeartbeat = native.workerRecordActivityHeartbeat.bind(undefined, nativeWorker);
    this.initiateShutdown = native.workerInitiateShutdown.bind(undefined, nativeWorker);
  }

  flushCoreLogs(): void {
    this.runtime.flushLogs();
  }

  public async finalizeShutdown(): Promise<void> {
    await this.runtime.deregisterWorker(this.nativeWorker);
  }
}

function formatTaskToken(taskToken: Uint8Array) {
  return Buffer.from(taskToken).toString('base64');
}

/**
 * Notify that an activity has started, used as input to {@link Worker.activityHeartbeatSubject}
 *
 * Used to detect rogue activities.
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
  info: ActivityInfo;
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
   *
   * This includes both local and non-local Activities.
   *
   * See {@link numInFlightNonLocalActivities} and {@link numInFlightLocalActivities} for a breakdown.
   */
  numInFlightActivities: number;
  /**
   * Number of in-flight (currently actively processed) non-Local Activities
   */
  numInFlightNonLocalActivities: number;
  /**
   * Number of in-flight (currently actively processed) Local Activities
   */
  numInFlightLocalActivities: number;
  /**
   * Number of Workflow executions cached in Worker memory
   */
  numCachedWorkflows: number;

  /**
   * Number of running Activities that have emitted a heartbeat
   */
  numHeartbeatingActivities: number;
}

interface RunUntilOptions {
  /**
   * Maximum time to wait for the provided Promise to complete after the Worker has stopped or failed.
   *
   * Until TS SDK 1.11.2, `Worker.runUntil(...)` would wait _indefinitely_ for both the Worker's run
   * Promise _and_ the provided Promise to resolve or fail, _even in error cases_. In most practical
   * use cases, that would create a possibility for the Worker to hang indefinitely if the Worker
   * was stopped due to "unexpected" factors
   *
   * For example, in the common test idiom show below, sending a `SIGINT` to the process would
   * initiate shutdown of the Worker, potentially resulting in termination of the Worker before the
   * Workflow completes; in that case, the Workflow would never complete, and consequently, the
   * `runUntil` Promise would never resolve, leaving the process in a hang state.
   *
   * ```ts
   * await Worker.runUntil(() => client.workflow.execute(...));
   * ```
   *
   * The behavior of `Worker.runUntil(...)` has therefore been changedin 1.11.3 so that if the worker
   * shuts down before the inner promise completes, `runUntil` will allow no more than a certain delay
   * (i.e. `promiseCompletionTimeout`) for the inner promise to complete, after which a
   * {@link PromiseCompletionTimeoutError} is thrown.
   *
   * In most practical use cases, no delay is actually required; `promiseCompletionTimeout` therefore
   * defaults to 0 second, meaning the Worker will not wait for the inner promise to complete.
   * You may adjust this value in the very rare cases where waiting is pertinent; set it to a
   * very high value to mimic the previous behavior.
   *
   * This time is calculated from the moment the Worker reachs either the `STOPPED` or the `FAILED`
   * state. {@link Worker.runUntil} throws a {@link PromiseCompletionTimeoutError} if the if the
   * Promise still hasn't completed after that delay.
   *
   * @default 0 don't wait
   */
  promiseCompletionTimeout?: Duration;
}

/**
 * The temporal Worker connects to Temporal Server and runs Workflows and Activities.
 */
export class Worker {
  protected readonly activityHeartbeatSubject = new Subject<HeartbeatInput>();
  protected readonly stateSubject = new BehaviorSubject<State>('INITIALIZED');

  // Pushing an error to this subject causes the Worker to initiate a graceful shutdown, after
  // which the Worker will be in FAILED state and the `run` promise will throw the first error
  // published on this subject.
  protected readonly unexpectedErrorSubject = new Subject<void>();

  // Pushing an error to this subject will cause the worker to IMMEDIATELY fall into FAILED state.
  //
  // The `run` promise will throw the first error reported on either this subject or the
  // `unexpectedErrorSubject` subject. That is, suppose that an "unexpected error" comes in,
  // which triggers graceful shutdown of the Worker, and then, while attempting to gracefully shut
  // down the Worker, we get some "instant terminate error". The Worker's `run` promise will throw
  // the _initial error_ rather than the "instant terminate error" that came later. This is so to
  // avoid masking the original error with a subsequent one that will likely be less relevant.
  // Both errors will still be reported to the logger.
  protected readonly instantTerminateErrorSubject = new Subject<void>();

  protected readonly workflowPollerStateSubject = new BehaviorSubject<PollerState>('POLLING');
  protected readonly activityPollerStateSubject = new BehaviorSubject<PollerState>('POLLING');
  protected readonly nexusPollerStateSubject = new BehaviorSubject<PollerState>('POLLING');

  /**
   * Whether or not this worker has an outstanding workflow poll request
   */
  protected hasOutstandingWorkflowPoll = false;
  /**
   * Whether or not this worker has an outstanding activity poll request
   */
  protected hasOutstandingActivityPoll = false;
  /**
   * Whether or not this worker has an outstanding Nexus poll request
   */
  protected hasOutstandingNexusPoll = false;

  protected client?: Client;

  protected readonly numInFlightActivationsSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightNonLocalActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightLocalActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightNexusOperationsSubject = new BehaviorSubject<number>(0);
  protected readonly numCachedWorkflowsSubject = new BehaviorSubject<number>(0);
  protected readonly numHeartbeatingActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly evictionsEmitter = new EventEmitter();

  private readonly taskTokenToNexusHandler = new Map<string, NexusHandler>();

  protected static nativeWorkerCtor: NativeWorkerConstructor = NativeWorker;
  // Used to add uniqueness to replay worker task queue names
  protected static replayWorkerCount = 0;
  private static readonly SELF_INDUCED_SHUTDOWN_EVICTION: RemoveFromCache = {
    message: 'Shutting down',
    reason: EvictionReason.FATAL,
  };
  protected readonly workflowCodecRunner: WorkflowCodecRunner;

  /**
   * Create a new Worker.
   * This method initiates a connection to the server and will throw (asynchronously) on connection failure.
   */
  public static async create(options: WorkerOptions): Promise<Worker> {
    if (!options.taskQueue) {
      throw new TypeError('Task queue name is required');
    }
    throwIfReservedName('task queue', options.taskQueue);
    const runtime = Runtime.instance();
    const logger = LoggerWithComposedMetadata.compose(runtime.logger, {
      sdkComponent: SdkComponent.worker,
      taskQueue: options.taskQueue ?? 'default',
    });
    const metricMeter = runtime.metricMeter.withTags({
      namespace: options.namespace ?? 'default',
      taskQueue: options.taskQueue ?? 'default',
    });
    const nativeWorkerCtor: NativeWorkerConstructor = this.nativeWorkerCtor;
    const compiledOptions = compileWorkerOptions(options, logger, metricMeter);
    logger.debug('Creating worker', {
      options: {
        ...compiledOptions,
        ...(compiledOptions.workflowBundle && isCodeBundleOption(compiledOptions.workflowBundle)
          ? {
              // Avoid dumping workflow bundle code to the console
              workflowBundle: <WorkflowBundle>{
                code: `<string of length ${compiledOptions.workflowBundle.code.length}>`,
              },
            }
          : {}),
      },
    });
    const bundle = await this.getOrCreateBundle(compiledOptions, logger);
    let workflowCreator: WorkflowCreator | undefined = undefined;
    if (bundle) {
      workflowCreator = await this.createWorkflowCreator(bundle, compiledOptions, logger);
    }
    // Create a new connection if one is not provided with no CREATOR reference
    // so it can be automatically closed when this Worker shuts down.
    const connection = options.connection ?? (await InternalNativeConnection.connect());
    let nativeWorker: NativeWorkerLike;
    const compiledOptionsWithBuildId = addBuildIdIfMissing(compiledOptions, bundle?.code);
    try {
      nativeWorker = await nativeWorkerCtor.create(runtime, connection, compiledOptionsWithBuildId);
    } catch (err) {
      // We just created this connection, close it
      if (!options.connection) {
        await connection.close();
      }
      throw err;
    }
    extractReferenceHolders(connection).add(nativeWorker);
    return new this(
      runtime,
      nativeWorker,
      workflowCreator,
      compiledOptionsWithBuildId,
      logger,
      metricMeter,
      connection
    );
  }

  protected static async createWorkflowCreator(
    workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    compiledOptions: CompiledWorkerOptions,
    logger: Logger
  ): Promise<WorkflowCreator> {
    const registeredActivityNames = new Set(compiledOptions.activities.keys());
    // This isn't required for vscode, only for Chrome Dev Tools which doesn't support debugging worker threads.
    // We also rely on this in debug-replayer where we inject a global variable to be read from workflow context.
    if (compiledOptions.debugMode) {
      if (compiledOptions.reuseV8Context) {
        return await ReusableVMWorkflowCreator.create(
          workflowBundle,
          compiledOptions.isolateExecutionTimeoutMs,
          registeredActivityNames
        );
      }
      return await VMWorkflowCreator.create(
        workflowBundle,
        compiledOptions.isolateExecutionTimeoutMs,
        registeredActivityNames
      );
    } else {
      return await ThreadedVMWorkflowCreator.create({
        workflowBundle,
        threadPoolSize: compiledOptions.workflowThreadPoolSize,
        isolateExecutionTimeoutMs: compiledOptions.isolateExecutionTimeoutMs,
        reuseV8Context: compiledOptions.reuseV8Context ?? true,
        registeredActivityNames,
        logger,
      });
    }
  }

  /**
   * Create a replay Worker, and run the provided history against it. Will resolve as soon as
   * the history has finished being replayed, or if the workflow produces a nondeterminism error.
   *
   * @param workflowId If provided, use this as the workflow id during replay. Histories do not
   * contain a workflow id, so it must be provided separately if your workflow depends on it.
   * @throws {@link DeterminismViolationError} if the workflow code is not compatible with the history.
   * @throws {@link ReplayError} on any other replay related error.
   */
  public static async runReplayHistory(
    options: ReplayWorkerOptions,
    history: History | unknown,
    workflowId?: string
  ): Promise<void> {
    const validated = this.validateHistory(history);
    const result = await this.runReplayHistories(options, [
      { history: validated, workflowId: workflowId ?? 'fake' },
    ]).next();
    if (result.done) throw new IllegalStateError('Expected at least one replay result');
    if (result.value.error) throw result.value.error;
  }

  /**
   * Create a replay Worker, running all histories provided by the passed in iterable.
   *
   * Returns an async iterable of results for each history replayed.
   */
  public static async *runReplayHistories(
    options: ReplayWorkerOptions,
    histories: ReplayHistoriesIterable
  ): AsyncIterableIterator<ReplayResult> {
    const [worker, pusher] = await this.constructReplayWorker(options);
    const rt = worker.runtime;
    const evictions = on(worker.evictionsEmitter, 'eviction') as AsyncIterableIterator<[EvictionWithRunID]>;
    const runPromise = worker.run().then(() => {
      throw new ShutdownError('Worker was shutdown');
    });
    void runPromise.catch(() => {
      // ignore to avoid unhandled rejections
    });
    let innerError = undefined;
    try {
      try {
        for await (const { history, workflowId } of histories) {
          const validated = this.validateHistory(history);
          await rt.pushHistory(pusher, workflowId, validated);
          const next = await Promise.race([evictions.next(), runPromise]);
          if (next.done) {
            break; // This shouldn't happen, handle just in case
          }
          const [{ runId, evictJob }] = next.value;
          const error = evictionReasonToReplayError(evictJob);
          // We replay one workflow at a time so the workflow ID comes from the histories iterable.
          yield {
            workflowId,
            runId,
            error,
          };
        }
      } catch (err) {
        innerError = err;
      }
    } finally {
      try {
        rt.closeHistoryStream(pusher);
        worker.shutdown();
      } catch {
        // ignore in case worker was already shutdown
      }
      try {
        await runPromise;
      } catch (err) {
        /* eslint-disable no-unsafe-finally */
        if (err instanceof ShutdownError) {
          if (innerError !== undefined) throw innerError;
          return;
        } else if (innerError === undefined) {
          throw err;
        } else {
          throw new CombinedWorkerRunError('Worker run failed with inner error', {
            cause: {
              workerError: err,
              innerError,
            },
          });
        }
        /* eslint-enable no-unsafe-finally */
      }
    }
  }

  private static validateHistory(history: unknown): History {
    if (typeof history !== 'object' || history == null) {
      throw new TypeError(`Expected a non-null history object, got ${typeof history}`);
    }
    const { eventId } = (history as any).events[0];
    // in a "valid" history, eventId would be Long
    if (typeof eventId === 'string') {
      return historyFromJSON(history);
    } else {
      return history;
    }
  }

  private static async constructReplayWorker(options: ReplayWorkerOptions): Promise<[Worker, native.HistoryPusher]> {
    const nativeWorkerCtor: NativeWorkerConstructor = this.nativeWorkerCtor;
    const fixedUpOptions: WorkerOptions = {
      taskQueue: (options.replayName ?? 'fake_replay_queue') + '-' + this.replayWorkerCount,
      debugMode: true,
      ...options,
    };
    this.replayWorkerCount++;
    const runtime = Runtime.instance();
    const logger = LoggerWithComposedMetadata.compose(runtime.logger, {
      sdkComponent: 'worker',
      taskQueue: fixedUpOptions.taskQueue,
    });
    const metricMeter = runtime.metricMeter.withTags({
      namespace: 'default',
      taskQueue: fixedUpOptions.taskQueue,
    });
    const compiledOptions = compileWorkerOptions(fixedUpOptions, logger, metricMeter);
    const bundle = await this.getOrCreateBundle(compiledOptions, logger);
    if (!bundle) {
      throw new TypeError('ReplayWorkerOptions must contain workflowsPath or workflowBundle');
    }
    const workflowCreator = await this.createWorkflowCreator(bundle, compiledOptions, logger);
    const replayHandle = await nativeWorkerCtor.createReplay(
      runtime,
      addBuildIdIfMissing(compiledOptions, bundle.code)
    );
    return [
      new this(runtime, replayHandle.worker, workflowCreator, compiledOptions, logger, metricMeter, undefined, true),
      replayHandle.historyPusher,
    ];
  }

  protected static async getOrCreateBundle(
    compiledOptions: CompiledWorkerOptions,
    logger: Logger
  ): Promise<WorkflowBundleWithSourceMapAndFilename | undefined> {
    if (compiledOptions.workflowBundle) {
      if (compiledOptions.workflowsPath) {
        logger.warn('Ignoring WorkerOptions.workflowsPath because WorkerOptions.workflowBundle is set');
      }
      if (compiledOptions.bundlerOptions) {
        logger.warn('Ignoring WorkerOptions.bundlerOptions because WorkerOptions.workflowBundle is set');
      }
      const modules = new Set(compiledOptions.interceptors.workflowModules);
      // Warn if user tries to customize the default set of workflow interceptor modules

      if (
        modules &&
        new Set([...modules, ...defaultWorkflowInterceptorModules]).size !== defaultWorkflowInterceptorModules.length
      ) {
        logger.warn(
          'Ignoring WorkerOptions.interceptors.workflowModules because WorkerOptions.workflowBundle is set.\n' +
            'To use workflow interceptors with a workflowBundle, pass them in the call to bundleWorkflowCode.'
        );
      }

      if (isCodeBundleOption(compiledOptions.workflowBundle)) {
        return parseWorkflowCode(compiledOptions.workflowBundle.code);
      } else if (isPathBundleOption(compiledOptions.workflowBundle)) {
        const code = await fs.readFile(compiledOptions.workflowBundle.codePath, 'utf8');
        return parseWorkflowCode(code, compiledOptions.workflowBundle.codePath);
      } else {
        throw new TypeError('Invalid WorkflowOptions.workflowBundle');
      }
    } else if (compiledOptions.workflowsPath) {
      const bundler = new WorkflowCodeBundler({
        logger,
        workflowsPath: compiledOptions.workflowsPath,
        workflowInterceptorModules: compiledOptions.interceptors.workflowModules,
        failureConverterPath: compiledOptions.dataConverter?.failureConverterPath,
        payloadConverterPath: compiledOptions.dataConverter?.payloadConverterPath,
        ignoreModules: compiledOptions.bundlerOptions?.ignoreModules,
        webpackConfigHook: compiledOptions.bundlerOptions?.webpackConfigHook,
      });
      const bundle = await bundler.createBundle();
      return parseWorkflowCode(bundle.code);
    } else {
      return undefined;
    }
  }

  /**
   * Create a new Worker from nativeWorker.
   */
  protected constructor(
    protected readonly runtime: Runtime,
    protected readonly nativeWorker: NativeWorkerLike,
    /**
     * Optional WorkflowCreator - if not provided, Worker will not poll on Workflows
     */
    protected readonly workflowCreator: WorkflowCreator | undefined,
    public readonly options: CompiledWorkerOptions,
    /** Logger bound to 'sdkComponent: worker' */
    protected readonly logger: Logger,
    protected readonly metricMeter: MetricMeter,
    protected readonly connection?: NativeConnection,
    protected readonly isReplayWorker: boolean = false
  ) {
    this.workflowCodecRunner = new WorkflowCodecRunner(options.loadedDataConverter.payloadCodecs);
    if (connection != null) {
      // connection (and consequently client) will be set IIF this is not a replay worker.
      this.client = new Client({
        namespace: options.namespace,
        connection,
        identity: options.identity,
        dataConverter: options.dataConverter,
        interceptors: options.interceptors.client,
      });
    }
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
      numInFlightNonLocalActivities: this.numInFlightNonLocalActivitiesSubject.value,
      numInFlightLocalActivities: this.numInFlightLocalActivitiesSubject.value,
    };
  }

  protected get state(): State {
    return this.stateSubject.getValue();
  }

  protected set state(state: State) {
    this.logger.info('Worker state changed', { state });
    this.stateSubject.next(state);
  }

  /**
   * Start shutting down the Worker. The Worker stops polling for new tasks and sends
   * {@link https://typescript.temporal.io/api/namespaces/activity#cancellation | cancellation}
   * (via a {@link CancelledFailure} with `message` set to `'WORKER_SHUTDOWN'`) to running Activities.
   * Note: if the Activity accepts cancellation (i.e. re-throws or allows the `CancelledFailure`
   * to be thrown out of the Activity function), the Activity Task will be marked as failed, not
   * cancelled. It's helpful for the Activity Task to be marked failed during shutdown because the
   * Server will retry the Activity sooner (than if the Server had to wait for the Activity Task
   * to time out).
   *
   * When called, immediately transitions {@link state} to `'STOPPING'` and asks Core to shut down.
   * Once Core has confirmed that it's shutting down, the Worker enters `'DRAINING'` state. It will
   * stay in that state until both task pollers receive a `ShutdownError`, at which point we'll
   * transition to `DRAINED` state. Once all currently running Activities and Workflow Tasks have
   * completed, the Worker transitions to `'STOPPED'`.
   */
  shutdown(): void {
    if (this.state !== 'RUNNING') {
      throw new IllegalStateError(`Not running. Current state: ${this.state}`);
    }
    this.state = 'STOPPING';
    try {
      this.nativeWorker.initiateShutdown();
      this.state = 'DRAINING';
    } catch (error) {
      // This is totally unexpected, and indicates there's something horribly wrong with the Worker
      // state. Attempt to shutdown gracefully will very likely hang, so just terminate immediately.
      this.logger.error('Failed to initiate shutdown', { error });
      this.instantTerminateErrorSubject.error(error);
    }
  }

  /**
   * An observable that completes when {@link state} becomes `'DRAINED'` or throws if {@link state} transitions to
   * `'STOPPING'` and remains that way for {@link this.options.shutdownForceTimeMs}.
   */
  protected forceShutdown$(): Observable<never> {
    if (this.options.shutdownForceTimeMs == null) {
      return EMPTY;
    }
    return race(
      this.stateSubject.pipe(
        filter((state): state is 'STOPPING' => state === 'STOPPING'),
        delay(this.options.shutdownForceTimeMs),
        tap({
          next: () => {
            // Inject the error into the instantTerminateError subject so that we don't mask
            // any error that might have caused the Worker to shutdown in the first place.
            this.logger.debug('Shutdown force time expired, terminating worker');
            this.instantTerminateErrorSubject.error(
              new GracefulShutdownPeriodExpiredError('Timed out while waiting for worker to shutdown gracefully')
            );
          },
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
            if (err instanceof ShutdownError) {
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
  protected activityOperator(): OperatorFunction<ActivityTaskWithBase64Token, Uint8Array> {
    return pipe(
      closeableGroupBy(({ base64TaskToken }) => base64TaskToken),
      mergeMap((group$) => {
        return group$.pipe(
          mergeMapWithState(
            async (activity: Activity | undefined, { task, base64TaskToken, protobufEncodedTask }) => {
              const { taskToken, variant } = task;
              if (!variant) {
                throw new TypeError('Got an activity task without a "variant" attribute');
              }

              // We either want to return an activity result (for failures) or pass on the activity for running at a later stage
              // If cancel is requested we ignore the result of this function
              // We don't run the activity directly in this operator because we need to return the activity in the state
              // so it can be cancelled if requested
              let output:
                | {
                    type: 'result';
                    result: coresdk.activity_result.IActivityExecutionResult;
                  }
                | {
                    type: 'run';
                    activity: Activity;
                    input: ActivityExecuteInput;
                  }
                | { type: 'ignore' };
              switch (variant) {
                case 'start': {
                  let info: ActivityInfo | undefined = undefined;
                  try {
                    if (activity !== undefined) {
                      throw new IllegalStateError(
                        `Got start event for an already running activity: ${base64TaskToken}`
                      );
                    }
                    info = await extractActivityInfo(
                      task,
                      this.options.loadedDataConverter,
                      this.options.namespace,
                      this.options.taskQueue
                    );

                    const { activityType } = info;
                    // Use the corresponding activity if it exists, otherwise, fallback to default activity function (if exists)
                    const fn = this.options.activities.get(activityType) ?? this.options.activities.get('default');
                    if (typeof fn !== 'function') {
                      throw ApplicationFailure.create({
                        type: 'NotFoundError',
                        message: `Activity function ${activityType} is not registered on this Worker, available activities: ${JSON.stringify(
                          [...this.options.activities.keys()]
                        )}`,
                        nonRetryable: false,
                      });
                    }
                    let args: unknown[];
                    try {
                      args = await decodeArrayFromPayloads(this.options.loadedDataConverter, task.start?.input);
                    } catch (err) {
                      throw ApplicationFailure.fromError(err, {
                        message: `Failed to parse activity args for activity ${activityType}: ${errorMessage(err)}`,
                        nonRetryable: false,
                      });
                    }
                    const headers = task.start?.headerFields ?? {};
                    const input = {
                      args,
                      headers,
                    };

                    this.logger.trace('Starting activity', activityLogAttributes(info));

                    activity = new Activity(
                      info,
                      fn,
                      this.options.loadedDataConverter,
                      (details) =>
                        this.activityHeartbeatSubject.next({
                          type: 'heartbeat',
                          info: info!,
                          taskToken,
                          base64TaskToken,
                          details,
                          onError() {
                            // activity must be defined
                            // empty cancellation details, no corresponding detail for heartbeat detail conversion failure
                            activity?.cancel(
                              'HEARTBEAT_DETAILS_CONVERSION_FAILED',
                              ActivityCancellationDetails.fromProto(undefined)
                            );
                          },
                        }),
                      this.client,
                      this.logger,
                      this.metricMeter,
                      this.options.interceptors.activity
                    );
                    output = { type: 'run', activity, input };
                    break;
                  } catch (e) {
                    const error = ensureApplicationFailure(e);
                    this.logger.error(`Error while processing ActivityTask.start: ${errorMessage(error)}`, {
                      ...(info ? activityLogAttributes(info) : {}),
                      error: e,
                      task: JSON.stringify(task.toJSON()),
                      taskEncoded: Buffer.from(protobufEncodedTask).toString('base64'),
                    });
                    output = {
                      type: 'result',
                      result: {
                        failed: {
                          failure: await encodeErrorToFailure(this.options.loadedDataConverter, error),
                        },
                      },
                    };
                    break;
                  }
                }
                case 'cancel': {
                  output = { type: 'ignore' };
                  if (activity === undefined) {
                    this.logger.trace('Tried to cancel a non-existing activity', {
                      taskToken: base64TaskToken,
                    });
                    break;
                  }
                  // NOTE: activity will not be considered cancelled until it confirms cancellation (by throwing a CancelledFailure)
                  this.logger.trace('Cancelling activity', activityLogAttributes(activity.info));
                  const reason = task.cancel?.reason;
                  const cancellationDetails = task.cancel?.details;
                  if (reason === undefined || reason === null) {
                    // Special case of Lang side cancellation during shutdown (see `activity.shutdown.evict` above)
                    activity.cancel('WORKER_SHUTDOWN', ActivityCancellationDetails.fromProto(cancellationDetails));
                  } else {
                    activity.cancel(
                      coresdk.activity_task.ActivityCancelReason[reason] as CancelReason,
                      ActivityCancellationDetails.fromProto(cancellationDetails)
                    );
                  }
                  break;
                }
              }
              return { state: activity, output: { taskToken, output } };
            },
            undefined // initial value
          ),
          mergeMap(async ({ output, taskToken }) => {
            if (output.type === 'ignore') {
              return undefined;
            }
            if (output.type === 'result') {
              return { taskToken, result: output.result };
            }
            const { base64TaskToken } = output.activity.info;

            this.activityHeartbeatSubject.next({
              type: 'create',
              base64TaskToken,
            });

            let result;

            const numInFlightBreakdownSubject = output.activity.info.isLocal
              ? this.numInFlightLocalActivitiesSubject
              : this.numInFlightNonLocalActivitiesSubject;

            this.numInFlightActivitiesSubject.next(this.numInFlightActivitiesSubject.value + 1);
            numInFlightBreakdownSubject.next(numInFlightBreakdownSubject.value + 1);
            try {
              result = await output.activity.run(output.input);
            } finally {
              numInFlightBreakdownSubject.next(numInFlightBreakdownSubject.value - 1);
              this.numInFlightActivitiesSubject.next(this.numInFlightActivitiesSubject.value - 1);
            }
            const status = result.failed ? 'failed' : result.completed ? 'completed' : 'cancelled';

            if (status === 'failed') {
              // Make sure to flush the last heartbeat
              this.logger.trace('Activity failed, waiting for heartbeats to be flushed', {
                ...activityLogAttributes(output.activity.info),
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
            this.logger.trace('Activity resolved', {
              ...activityLogAttributes(output.activity.info),
              status,
            });
            return { taskToken, result };
          }),
          filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
          map((rest) => coresdk.ActivityTaskCompletion.encodeDelimited(rest).finish()),
          tap({
            next: () => {
              group$.close();
            },
          })
        );
      })
    );
  }

  /**
   * Process Nexus tasks
   */
  protected nexusOperator(): OperatorFunction<NexusTaskWithBase64Token, Uint8Array> {
    return pipe(
      mergeMap(
        async ({
          task,
          base64TaskToken,
          protobufEncodedTask,
        }): Promise<coresdk.nexus.INexusTaskCompletion | undefined> => {
          const { variant } = task;
          if (!variant) {
            throw new TypeError('Got a nexus task without a "variant" attribute');
          }

          switch (variant) {
            case 'task': {
              if (task.task == null) {
                throw new IllegalStateError(`Got empty task for task variant with token: ${base64TaskToken}`);
              }
              return await this.handleNexusRunTask(task.task, base64TaskToken, protobufEncodedTask);
            }
            case 'cancelTask': {
              const nexusHandler = this.taskTokenToNexusHandler.get(base64TaskToken);
              if (nexusHandler == null) {
                this.logger.trace('Tried to cancel a non-existing Nexus handler', {
                  taskToken: base64TaskToken,
                });
                break;
              }
              // NOTE: Nexus handler will not be considered cancelled until it confirms cancellation (by throwing a CancelledFailure)
              this.logger.trace('Cancelling Nexus handler', nexusHandler.getLogAttributes());
              let reason = 'unkown';
              if (task.cancelTask?.reason != null) {
                reason = coresdk.nexus.NexusTaskCancelReason[task.cancelTask.reason];
              }
              nexusHandler.abortController.abort(new CancelledFailure(reason));
              return;
            }
          }
        }
      ),
      filter(<T>(result: T): result is Exclude<T, undefined> => result !== undefined),
      map((result) => coresdk.nexus.NexusTaskCompletion.encodeDelimited(result).finish())
    );
  }

  private async handleNexusRunTask(
    task: temporal.api.workflowservice.v1.IPollNexusTaskQueueResponse,
    base64TaskToken: string,
    protobufEncodedTask: ArrayBuffer
  ) {
    const { taskToken } = task;
    if (taskToken == null) {
      throw new nexus.HandlerError('INTERNAL', 'Task missing request task token');
    }

    let nexusHandler: NexusHandler | undefined = undefined;
    try {
      const abortController = new AbortController();

      nexusHandler = new NexusHandler(
        taskToken,
        this.options.namespace,
        this.options.taskQueue,
        constructNexusOperationContext(task.request, abortController.signal),
        this.client!, // Must be defined if we are handling Nexus tasks.
        abortController,
        this.options.nexusServiceRegistry!, // Must be defined if we are handling Nexus tasks.
        this.options.loadedDataConverter,
        this.logger,
        this.metricMeter,
        this.options.interceptors.nexus
      );
      this.taskTokenToNexusHandler.set(base64TaskToken, nexusHandler);
      this.numInFlightNexusOperationsSubject.next(this.numInFlightNexusOperationsSubject.value + 1);
      try {
        return await nexusHandler.run(task);
      } finally {
        this.numInFlightNexusOperationsSubject.next(this.numInFlightNexusOperationsSubject.value - 1);
        this.taskTokenToNexusHandler.delete(base64TaskToken);
      }
    } catch (e) {
      this.logger.error(`Error while processing Nexus task: ${errorMessage(e)}`, {
        ...(nexusHandler?.getLogAttributes() ?? {}),
        error: e,
        taskEncoded: Buffer.from(protobufEncodedTask).toString('base64'),
      });
      const handlerError =
        e instanceof nexus.HandlerError ? e : new nexus.HandlerError('INTERNAL', undefined, { cause: e });
      return {
        taskToken,
        error: await handlerErrorToProto(this.options.loadedDataConverter, handlerError),
      };
    }
  }

  /**
   * Process activations from the same workflow execution to an observable of completions.
   *
   * Injects a synthetic eviction activation when the worker transitions to no longer polling.
   */
  protected handleWorkflowActivations(
    activations$: CloseableGroupedObservable<string, coresdk.workflow_activation.WorkflowActivation>
  ): Observable<Uint8Array> {
    const syntheticEvictionActivations$ = this.workflowPollerStateSubject.pipe(
      // Core has indicated that it will not return any more poll results; evict all cached WFs.
      filter((state) => state !== 'POLLING'),
      first(),
      map(() => ({
        activation: coresdk.workflow_activation.WorkflowActivation.create({
          runId: activations$.key,
          jobs: [{ removeFromCache: Worker.SELF_INDUCED_SHUTDOWN_EVICTION }],
        }),
        synthetic: true,
      })),
      takeUntil(activations$.pipe(last(undefined, null)))
    );
    const activations$$ = activations$.pipe(map((activation) => ({ activation, synthetic: false })));
    return merge(activations$$, syntheticEvictionActivations$).pipe(
      tap(() => {
        this.numInFlightActivationsSubject.next(this.numInFlightActivationsSubject.value + 1);
      }),
      mergeMapWithState(this.handleActivation.bind(this), undefined),
      tap(({ close }) => {
        this.numInFlightActivationsSubject.next(this.numInFlightActivationsSubject.value - 1);
        if (close) {
          activations$.close();
          this.numCachedWorkflowsSubject.next(this.numCachedWorkflowsSubject.value - 1);
        }
      }),
      takeWhile(({ close }) => !close, true /* inclusive */),
      map(({ completion }) => completion),
      filter((result): result is Uint8Array => result !== undefined)
    );
  }

  /**
   * Process a single activation to a completion.
   */
  protected async handleActivation(
    workflow: WorkflowWithLogAttributes | undefined,
    { activation, synthetic }: { activation: coresdk.workflow_activation.WorkflowActivation; synthetic: boolean }
  ): Promise<{
    state: WorkflowWithLogAttributes | undefined;
    output: { completion?: Uint8Array; close: boolean };
  }> {
    try {
      const removeFromCacheIx = activation.jobs.findIndex(({ removeFromCache }) => removeFromCache);
      const close = removeFromCacheIx !== -1;
      const jobs = activation.jobs;
      if (close) {
        const asEvictJob = jobs.splice(removeFromCacheIx, 1)[0].removeFromCache;
        if (asEvictJob) {
          this.evictionsEmitter.emit('eviction', {
            runId: activation.runId,
            evictJob: asEvictJob,
          } as EvictionWithRunID);
        }
      }
      activation.jobs = jobs;
      if (jobs.length === 0) {
        this.logger.trace('Disposing workflow', workflow ? workflow.logAttributes : { runId: activation.runId });
        await workflow?.workflow.dispose();
        if (!close) {
          throw new IllegalStateError('Got a Workflow activation with no jobs');
        }
        const completion = synthetic
          ? undefined
          : coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited({
              runId: activation.runId,
              successful: {},
            }).finish();
        return { state: undefined, output: { close, completion } };
      }

      const decodedActivation = await this.workflowCodecRunner.decodeActivation(activation);

      if (workflow === undefined) {
        const initWorkflowDetails = decodedActivation.jobs[0]?.initializeWorkflow;
        if (initWorkflowDetails == null)
          throw new IllegalStateError(
            'Received workflow activation for an untracked workflow with no init workflow job'
          );

        workflow = await this.createWorkflow(decodedActivation, initWorkflowDetails);
      }

      let isFatalError = false;
      try {
        const unencodedCompletion = await workflow.workflow.activate(decodedActivation);
        const completion = await this.workflowCodecRunner.encodeCompletion(unencodedCompletion);

        return { state: workflow, output: { close, completion } };
      } catch (err) {
        if (err instanceof UnexpectedError) {
          isFatalError = true;
        }
        throw err;
      } finally {
        // Fatal error means we cannot call into this workflow again unfortunately
        if (!isFatalError) {
          // When processing workflows through runReplayHistories, Core may still send non-replay
          // activations on the very last Workflow Task in some cases. Though Core is technically exact
          // here, the fact that sinks marked with callDuringReplay = false may get called on a replay
          // worker is definitely a surprising behavior. For that reason, we extend the isReplaying flag in
          // this case to also include anything running under in a replay worker.
          const isReplaying = activation.isReplaying || this.isReplayWorker;

          const calls = await workflow.workflow.getAndResetSinkCalls();
          await this.processSinkCalls(calls, isReplaying, workflow.logAttributes);
        }
        this.logger.trace('Completed activation', workflow.logAttributes);
      }
    } catch (error) {
      let logMessage = 'Failed to process Workflow Activation';
      if (error instanceof UnexpectedError) {
        // Something went wrong in the workflow; we'll do our best to shut the Worker
        // down gracefully, but then we'll need to terminate the Worker ASAP.
        logMessage = 'An unexpected error occured while processing Workflow Activation. Initiating Worker shutdown.';
        this.unexpectedErrorSubject.error(error);
      }

      this.logger.error(logMessage, {
        runId: activation.runId,
        ...workflow?.logAttributes,
        error,
        workflowExists: workflow !== undefined,
      });

      const completion = coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited({
        runId: activation.runId,
        failed: {
          failure: await encodeErrorToFailure(this.options.loadedDataConverter, error),
        },
      }).finish();

      // We do not dispose of the Workflow yet, wait to be evicted from Core.
      // This is done to simplify the Workflow lifecycle so Core is the sole driver.
      return { state: undefined, output: { close: true, completion } };
    }
  }

  protected async createWorkflow(
    activation: Decoded<coresdk.workflow_activation.WorkflowActivation>,
    initWorkflowJob: Decoded<coresdk.workflow_activation.IInitializeWorkflow>
  ): Promise<WorkflowWithLogAttributes> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const workflowCreator = this.workflowCreator!;
    if (
      !(
        initWorkflowJob.workflowId != null &&
        initWorkflowJob.workflowType != null &&
        initWorkflowJob.randomnessSeed != null &&
        initWorkflowJob.firstExecutionRunId != null &&
        initWorkflowJob.attempt != null &&
        initWorkflowJob.startTime != null
      )
    ) {
      throw new TypeError(`Malformed InitializeWorkflow activation: ${JSON.stringify(initWorkflowJob)}`);
    }
    if (activation.timestamp == null) {
      throw new TypeError('Got activation with no timestamp, cannot create a new Workflow instance');
    }
    const {
      workflowId,
      randomnessSeed,
      workflowType,
      parentWorkflowInfo,
      rootWorkflow,
      workflowExecutionTimeout,
      workflowRunTimeout,
      workflowTaskTimeout,
      continuedFromExecutionRunId,
      firstExecutionRunId,
      retryPolicy,
      attempt,
      cronSchedule,
      workflowExecutionExpirationTime,
      cronScheduleToScheduleInterval,
      priority,
    } = initWorkflowJob;

    // Note that we can't do payload conversion here, as there's no guarantee that converted payloads would be safe to
    // transfer through the V8 message port. Those will therefore be set in the Activator's initializeWorkflow job handler.
    const workflowInfo: WorkflowInfo = {
      workflowId,
      runId: activation.runId,
      workflowType,
      searchAttributes: {},
      typedSearchAttributes: new TypedSearchAttributes(),
      parent: convertToParentWorkflowType(parentWorkflowInfo),
      root: convertToRootWorkflowType(rootWorkflow),
      taskQueue: this.options.taskQueue,
      namespace: this.options.namespace,
      firstExecutionRunId,
      continuedFromExecutionRunId: continuedFromExecutionRunId || undefined,
      startTime: tsToDate(initWorkflowJob.startTime),
      runStartTime: tsToDate(activation.timestamp),
      executionTimeoutMs: optionalTsToMs(workflowExecutionTimeout),
      executionExpirationTime: optionalTsToDate(workflowExecutionExpirationTime),
      runTimeoutMs: optionalTsToMs(workflowRunTimeout),
      taskTimeoutMs: requiredTsToMs(workflowTaskTimeout, 'workflowTaskTimeout'),
      retryPolicy: decompileRetryPolicy(retryPolicy),
      attempt,
      cronSchedule: cronSchedule || undefined,
      // 0 is the default, and not a valid value, since crons are at least a minute apart
      cronScheduleToScheduleInterval: optionalTsToMs(cronScheduleToScheduleInterval) || undefined,
      historyLength: activation.historyLength,
      // Exact truncation for multi-petabyte histories
      // A zero value means that it was not set by the server
      historySize: activation.historySizeBytes.toNumber(),
      continueAsNewSuggested: activation.continueAsNewSuggested,
      currentBuildId: activation.deploymentVersionForCurrentTask?.buildId ?? '',
      currentDeploymentVersion: convertDeploymentVersion(activation.deploymentVersionForCurrentTask),
      unsafe: {
        now: () => Date.now(), // re-set in initRuntime
        isReplaying: activation.isReplaying,
      },
      priority: decodePriority(priority),
    };
    const logAttributes = workflowLogAttributes(workflowInfo);
    this.logger.trace('Creating workflow', logAttributes);

    const workflow = await workflowCreator.createWorkflow({
      info: workflowInfo,
      randomnessSeed: randomnessSeed.toBytes(),
      now: tsToMs(activation.timestamp),
      showStackTraceSources: this.options.showStackTraceSources,
    });

    this.numCachedWorkflowsSubject.next(this.numCachedWorkflowsSubject.value + 1);
    return { workflow, logAttributes };
  }

  /**
   * Process extracted external calls from Workflow post activation.
   *
   * Each SinkCall is translated into a injected sink function call.
   *
   * This function does not throw, it will log in case of missing sinks
   * or failed sink function invocations.
   */
  protected async processSinkCalls(
    externalCalls: SinkCall[],
    isReplaying: boolean,
    logAttributes: Record<string, unknown>
  ): Promise<void> {
    const { sinks } = this.options;

    const filteredCalls = externalCalls
      // Fix depreacted usage of the 'defaultWorkerLogger' sink
      .map((call) => (call.ifaceName === 'defaultWorkerLogger' ? { ...call, ifaceName: '__temporal_logger' } : call))
      // Map sink call to the corresponding sink function definition
      .map((call) => ({ call, sink: sinks?.[call.ifaceName]?.[call.fnName] }))
      // Reject calls to undefined sink definitions
      .filter(({ call: { ifaceName, fnName }, sink }) => {
        if (sink !== undefined) return true;
        this.logger.error('Workflow referenced an unregistered external sink', {
          ...logAttributes,
          ifaceName,
          fnName,
        });
        return false;
      })
      // If appropriate, reject calls to sink functions not configured with `callDuringReplay = true`
      .filter(({ sink }) => sink?.callDuringReplay || !isReplaying);

    // Make a wrapper function, to make things easier afterward
    await Promise.all(
      filteredCalls.map(async ({ call, sink }) => {
        try {
          await sink?.fn(call.workflowInfo, ...call.args);
        } catch (error) {
          this.logger.error('External sink function threw an error', {
            ...logAttributes,
            ifaceName: call.ifaceName,
            fnName: call.fnName,
            error,
            workflowInfo: call.workflowInfo,
          });
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
      return {
        state: { ...state, processing: true, pending: undefined },
        output: { type: 'send', heartbeat },
      };
    }

    function storePending(state: HeartbeatState, heartbeat: Heartbeat): HeartbeatStateAndOutput {
      return { state: { ...state, pending: heartbeat }, output: null };
    }

    function complete(callback: () => void): HeartbeatStateAndOutput {
      return {
        state: {
          pending: undefined,
          completionCallback: undefined,
          processing: false,
          closed: true,
        },
        output: { type: 'close', completionCallback: callback },
      };
    }

    return this.activityHeartbeatSubject.pipe(
      // The only way for this observable to be closed is by state changing to DRAINED meaning that all in-flight activities have been resolved and thus there should not be any heartbeats to send.
      this.takeUntilState('DRAINED'),
      tap({
        complete: () => this.logger.debug('Heartbeats complete'),
      }),
      closeableGroupBy(({ base64TaskToken }) => base64TaskToken),
      mergeMap((group$) =>
        group$.pipe(
          mapWithState(
            (state: HeartbeatState, input: HeartbeatInput): HeartbeatStateAndOutput => {
              if (input.type === 'create') {
                this.numHeartbeatingActivitiesSubject.next(this.numHeartbeatingActivitiesSubject.value + 1);
                return {
                  state: { processing: false, closed: false },
                  output: null,
                };
              }
              // Ignore any input if we've marked this activity heartbeat stream as closed
              // (rogue heartbeat)
              if (state.closed) return { state, output: { type: 'close' } };

              switch (input.type) {
                case 'heartbeat':
                  this.logger.trace('Got activity heartbeat', activityLogAttributes(input.info));
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
                    return {
                      state: { ...state, processing: false },
                      output: null,
                    };
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
          mergeMap(async ({ heartbeat: { base64TaskToken, taskToken, details, onError, info } }) => {
            let payload: Payload;
            try {
              try {
                payload = await encodeToPayload(this.options.loadedDataConverter, details);
              } catch (error: any) {
                this.logger.warn('Failed to encode heartbeat details, cancelling Activity', {
                  error,
                  ...activityLogAttributes(info),
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
              this.activityHeartbeatSubject.next({
                type: 'flush',
                base64TaskToken,
              });
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
  protected workflowPoll$(): Observable<WorkflowActivation> {
    return this.pollLoop$(async () => {
      this.hasOutstandingWorkflowPoll = true;
      let buffer: Buffer;
      try {
        buffer = await this.nativeWorker.pollWorkflowActivation();
      } finally {
        this.hasOutstandingWorkflowPoll = false;
      }
      const activation = coresdk.workflow_activation.WorkflowActivation.decode(new Uint8Array(buffer));
      this.logger.trace('Got workflow activation', activation);

      return activation;
    }).pipe(
      tap({
        complete: () => {
          this.logger.trace('Workflow Poller changed state to SHUTDOWN');
          this.workflowPollerStateSubject.next('SHUTDOWN');
        },
        error: () => {
          this.logger.trace('Workflow Poller changed state to FAILED');
          this.workflowPollerStateSubject.next('FAILED');
        },
      })
    );
  }

  /**
   * Poll for Workflow activations, handle them, and report completions.
   */
  protected workflow$(): Observable<void> {
    // This Worker did not register any workflows, return early
    if (this.workflowCreator === undefined) {
      this.logger.warn('No workflows registered, not polling for workflow tasks');
      this.workflowPollerStateSubject.next('SHUTDOWN');
      return EMPTY;
    }
    return this.workflowPoll$().pipe(
      closeableGroupBy((activation) => activation.runId),
      mergeMap(this.handleWorkflowActivations.bind(this)),
      mergeMap(async (completion) => {
        try {
          await this.nativeWorker.completeWorkflowActivation(Buffer.from(completion, completion.byteOffset));
        } catch (error) {
          this.logger.error('Core reported failure in completeWorkflowActivation(). Initiating Worker shutdown.', {
            error,
          });
          this.unexpectedErrorSubject.error(error);
        }
      }),
      tap({
        complete: () => {
          this.logger.debug('Workflow Worker terminated');
        },
      })
    );
  }

  /**
   * Poll core for `ActivityTask`s while respecting worker state
   */
  protected activityPoll$(): Observable<ActivityTaskWithBase64Token> {
    return this.pollLoop$(async () => {
      this.hasOutstandingActivityPoll = true;
      let buffer: Buffer;
      try {
        buffer = await this.nativeWorker.pollActivityTask();
      } finally {
        this.hasOutstandingActivityPoll = false;
      }
      const task = coresdk.activity_task.ActivityTask.decode(new Uint8Array(buffer));
      const { taskToken, ...rest } = task;
      const base64TaskToken = formatTaskToken(taskToken);
      this.logger.trace('Got activity task', {
        taskToken: base64TaskToken,
        ...rest,
      });
      const { variant } = task;
      if (variant === undefined) {
        throw new TypeError('Got an activity task without a "variant" attribute');
      }
      return { task, base64TaskToken, protobufEncodedTask: buffer };
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
    // This Worker did not register any activities, return early
    if (!this.options.activities?.size) {
      if (!this.isReplayWorker) this.logger.warn('No activities registered, not polling for activity tasks');
      this.activityPollerStateSubject.next('SHUTDOWN');
      return EMPTY;
    }
    return this.activityPoll$().pipe(
      this.activityOperator(),
      mergeMap(async (completion) => {
        await this.nativeWorker.completeActivityTask(Buffer.from(completion, completion.byteOffset));
      }),
      tap({ complete: () => this.logger.debug('Activity Worker terminated') })
    );
  }

  protected nexusPoll$(): Observable<NexusTaskWithBase64Token> {
    return this.pollLoop$(async () => {
      this.hasOutstandingNexusPoll = true;
      let buffer: Buffer;
      try {
        buffer = await this.nativeWorker.pollNexusTask();
      } finally {
        this.hasOutstandingNexusPoll = false;
      }
      const task = coresdk.nexus.NexusTask.decode(new Uint8Array(buffer));
      const taskToken = task.task?.taskToken || task.cancelTask?.taskToken;
      if (taskToken == null) {
        throw new TypeError('Got a Nexus task without a task token');
      }
      const base64TaskToken = formatTaskToken(taskToken);
      this.logger.trace('Got Nexus task', {
        taskToken: base64TaskToken,
        ...task,
      });
      return { task, base64TaskToken, protobufEncodedTask: buffer };
    }).pipe(
      tap({
        complete: () => {
          this.nexusPollerStateSubject.next('SHUTDOWN');
        },
        error: () => {
          this.nexusPollerStateSubject.next('FAILED');
        },
      })
    );
  }

  protected nexus$(): Observable<void> {
    // This Worker did not register any Nexus services, return early.
    if (this.options.nexusServiceRegistry == null) {
      if (!this.isReplayWorker) this.logger.info('No Nexus services registered, not polling for Nexus tasks');
      this.nexusPollerStateSubject.next('SHUTDOWN');
      return EMPTY;
    }
    return this.nexusPoll$().pipe(
      this.nexusOperator(),
      mergeMap(async (completion) => {
        await this.nativeWorker.completeNexusTask(Buffer.from(completion.buffer, completion.byteOffset));
      }),
      tap({ complete: () => this.logger.debug('Nexus Worker terminated') })
    );
  }

  protected takeUntilState<T>(state: State): MonoTypeOperatorFunction<T> {
    return takeUntil(this.stateSubject.pipe(filter((value) => value === state)));
  }

  /**
   * Run the Worker until `fnOrPromise` completes, then {@link shutdown} and wait for {@link run} to complete.
   *
   * Be aware that the Worker may shutdown for reasons other than the completion of the provided promise,
   * e.g. due to the process receiving a SIGINT signal, direct call to `Worker.shutdown()`, or a critical
   * error that imposes a shutdown of the Worker.
   *
   * Throws on fatal Worker errors.
   *
   * **SDK versions `>=1.11.3`**:
   * If the worker shuts down before the inner promise completes, allow no more than
   * {@link RunUntilOptions.promiseCompletionTimeout} for the inner promise to complete,
   * after which a {@link PromiseCompletionTimeoutError} is thrown.
   *
   * **SDK versions `>=1.5.0`**:
   * This method always waits for both worker shutdown and inner `fnOrPromise` to complete.
   * If one of worker run -or- the inner promise throw an error, that error is rethrown.
   * If both throw an error, a {@link CombinedWorkerRunError} with a `cause` attribute containing both errors.
   *
   * **SDK versions `< 1.5.0`**:
   * This method would not wait for worker to complete shutdown if the inner `fnOrPromise` threw an error.
   *
   * @returns the result of `fnOrPromise`
   */
  async runUntil<R>(fnOrPromise: Promise<R> | (() => Promise<R>), options?: RunUntilOptions): Promise<R> {
    const workerRunPromise = this.run();

    let innerResult: PromiseSettledResult<R> | undefined;
    const innerPromise = (async () => {
      try {
        const result = await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
        innerResult = { status: 'fulfilled', value: result };
      } catch (err) {
        innerResult = { status: 'rejected', reason: err };
      } finally {
        if (this.state === 'RUNNING') {
          this.shutdown();
        }
      }
    })();

    let workerError: Error | undefined;
    try {
      await workerRunPromise;
    } catch (err) {
      workerError = err as Error;
    }

    // Allow some extra time for the provided promise to resolve, if it hasn't already
    const promiseCompletionTimeoutMs = msToNumber(options?.promiseCompletionTimeout ?? 0);
    if (innerResult === undefined && promiseCompletionTimeoutMs > 0) {
      await timeoutPromise(innerPromise, promiseCompletionTimeoutMs);
    }
    if (innerResult === undefined) {
      innerResult = {
        status: 'rejected',
        reason: new PromiseCompletionTimeoutError(
          `Promise did not resolve within ${promiseCompletionTimeoutMs}ms after Worker completed shutdown`
        ),
      };
    }

    if (workerError === undefined) {
      if (innerResult.status === 'fulfilled') {
        return innerResult.value;
      } else {
        throw innerResult.reason;
      }
    } else {
      if (innerResult?.status === 'fulfilled') {
        throw workerError;
      } else {
        throw new CombinedWorkerRunError('Worker terminated with fatal error in `runUntil`', {
          cause: {
            workerError,
            innerError: innerResult.reason,
          },
        });
      }
    }
  }

  /**
   * Start polling on the Task Queue for tasks. Completes after graceful {@link shutdown}, once the Worker reaches the
   * `'STOPPED'` state.
   *
   * Throws on a fatal error or failure to shutdown gracefully.
   *
   * @see {@link errors}
   *
   * To stop polling, call {@link shutdown} or send one of {@link Runtime.options.shutdownSignals}.
   */
  async run(): Promise<void> {
    if (this.state !== 'INITIALIZED') {
      throw new IllegalStateError('Poller was already started');
    }
    this.state = 'RUNNING';

    const shutdownCallback = () => {
      if (this.state === 'RUNNING') this.shutdown();
    };
    this.runtime.registerShutdownSignalCallback(shutdownCallback);

    let fatalError: Error | undefined;
    const unexpectedErrorSubscription = this.unexpectedErrorSubject.subscribe({
      error: (e: Error) => {
        if (this.state === 'RUNNING') this.shutdown();
        if (fatalError === undefined) {
          fatalError = e;
        }
      },
    });

    try {
      try {
        await lastValueFrom(
          merge(
            this.instantTerminateErrorSubject.pipe(this.takeUntilState('DRAINED')),
            this.forceShutdown$(),
            this.activityHeartbeat$(),
            merge(this.workflow$(), this.activity$(), this.nexus$()).pipe(
              tap({
                complete: () => {
                  this.state = 'DRAINED';
                },
              })
            )
          ).pipe(
            // Reinject fatalError inside the stream, if any,
            // with precedence over the error from the pipe
            tap({
              complete: () => {
                if (fatalError) throw fatalError;
              },
              error: () => {
                if (fatalError) throw fatalError;
              },
            }),
            tap({
              complete: () => {
                this.state = 'STOPPED';
              },
              error: (error) => {
                this.logger.error('Worker failed', { error });
                this.state = 'FAILED';
              },
            })
          ),
          { defaultValue: undefined }
        );
      } finally {
        this.runtime.deregisterShutdownSignalCallback(shutdownCallback);

        await this.nativeWorker.finalizeShutdown();
      }
    } finally {
      unexpectedErrorSubscription.unsubscribe();
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

export function parseWorkflowCode(code: string, codePath?: string): WorkflowBundleWithSourceMapAndFilename {
  const [actualCode, sourceMapJson] = extractSourceMap(code);
  const sourceMap: RawSourceMap = JSON.parse(sourceMapJson);

  // JS debuggers (at least VSCode's) have a few requirements regarding the script and its source map, notably:
  // - The script file name's must look like an absolute path (relative paths are treated as node internals scripts)
  // - If the script contains a sourceMapURL directive, the executable 'file' indicated by the source map must match the
  //   filename of the script itself. If the source map's file is a relative path, then it gets resolved relative to cwd
  const filename = path.resolve(process.cwd(), codePath ?? sourceMap.file);
  if (filename !== codePath) {
    sourceMap.file = filename;
    const patchedSourceMapJson = Buffer.from(JSON.stringify(sourceMap)).toString('base64');
    const fixedSourceMappingUrl = `\n//# sourceMappingURL=data:application/json;base64,${patchedSourceMapJson}`;
    code = actualCode + fixedSourceMappingUrl;
  }

  // Preloading the script makes breakpoints significantly more reliable and more responsive
  let script: vm.Script | undefined = new vm.Script(code, { filename });
  let context: any = vm.createContext({});
  try {
    script.runInContext(context);
  } catch (_e) {
    // Context has not been properly configured, so eventual errors are possible. Just ignore at this point
  }

  // Keep these objects from GC long enough for debugger to complete parsing the source map and reporting locations
  // to the node process. Otherwise, the debugger risks source mapping resolution errors, meaning breakpoints wont work.
  setTimeoutUnref(10000).then(
    () => {
      script = undefined;
      context = undefined;
    },
    () => void 0
  );

  return { code, sourceMap, filename };
}

function extractSourceMap(code: string) {
  const sourceMapCommentPos = code.lastIndexOf('//# sourceMappingURL=data:');
  if (sourceMapCommentPos > 0) {
    const base64TagIndex = code.indexOf('base64,', sourceMapCommentPos);
    if (base64TagIndex > 0) {
      const sourceMapJson = Buffer.from(code.slice(base64TagIndex + 'base64,'.length).trimEnd(), 'base64').toString();
      const actualCode = code.slice(0, sourceMapCommentPos);
      return [actualCode, sourceMapJson];
    }
  }

  throw new Error("Can't extract inlined source map from the provided Workflow Bundle");
}

/**
 * Transform an ActivityTask into ActivityInfo to pass on into an Activity
 */
async function extractActivityInfo(
  task: coresdk.activity_task.ActivityTask,
  dataConverter: LoadedDataConverter,
  activityNamespace: string,
  taskQueue: string
): Promise<ActivityInfo> {
  // NOTE: We trust core to supply all of these fields instead of checking for null and undefined everywhere
  const { taskToken } = task as NonNullableObject<coresdk.activity_task.IActivityTask>;
  const start = task.start as NonNullableObject<coresdk.activity_task.IStart>;
  const activityId = start.activityId;
  let heartbeatDetails = undefined;
  try {
    heartbeatDetails = await decodeFromPayloadsAtIndex(dataConverter, 0, start.heartbeatDetails);
  } catch (e) {
    throw ApplicationFailure.fromError(e, {
      message: `Failed to parse heartbeat details for activity ${activityId}: ${errorMessage(e)}`,
    });
  }
  return {
    taskToken,
    taskQueue,
    base64TaskToken: formatTaskToken(taskToken),
    activityId,
    workflowExecution: start.workflowExecution as NonNullableObject<temporal.api.common.v1.WorkflowExecution>,
    attempt: start.attempt,
    isLocal: start.isLocal,
    activityType: start.activityType,
    workflowType: start.workflowType,
    heartbeatTimeoutMs: optionalTsToMs(start.heartbeatTimeout),
    heartbeatDetails,
    activityNamespace,
    workflowNamespace: start.workflowNamespace,
    scheduledTimestampMs: requiredTsToMs(start.scheduledTime, 'scheduledTime'),
    startToCloseTimeoutMs: requiredTsToMs(start.startToCloseTimeout, 'startToCloseTimeout'),
    scheduleToCloseTimeoutMs: requiredTsToMs(start.scheduleToCloseTimeout, 'scheduleToCloseTimeout'),
    currentAttemptScheduledTimestampMs: requiredTsToMs(
      start.currentAttemptScheduledTime,
      'currentAttemptScheduledTime'
    ),
    priority: decodePriority(start.priority),
    retryPolicy: decompileRetryPolicy(start.retryPolicy),
  };
}

/**
 * A utility function to await a promise with a timeout.
 *
 * This function properly cleans up the timer when the provided promise resolves or rejects.
 *
 * Returns a tuple with a boolean indicating if the promise resolved before the timeout,
 * and the result of the promise (if it completed).
 */
async function timeoutPromise<R>(promise: Promise<R>, timeout: number): Promise<readonly [true, R] | readonly [false]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timerPromise = new Promise((resolve) => {
      timer = setTimeoutCallback(resolve, timeout);
    });
    return await Promise.race([
      promise.then((result) => [true, result] as const),
      timerPromise.then(() => [false] as const),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A utility function that creates a timer promise, with an unrefed timer.
 */
async function setTimeoutUnref(timeout: number): Promise<void> {
  return new Promise((resolve) => setTimeoutCallback(resolve, timeout).unref());
}
