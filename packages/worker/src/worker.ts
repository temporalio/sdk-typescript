import fs from 'fs/promises';
import { promisify } from 'util';
import * as otel from '@opentelemetry/api';
import { SpanContext } from '@opentelemetry/api';
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
import { delay, filter, first, ignoreElements, map, mergeMap, takeUntil, takeWhile, tap } from 'rxjs/operators';
import * as native from '@temporalio/core-bridge';
import { coresdk, temporal } from '@temporalio/proto';
import { Info as ActivityInfo } from '@temporalio/activity';
import {
  arrayFromPayloads,
  DataConverter,
  defaultDataConverter,
  errorMessage,
  errorToFailure,
  IllegalStateError,
  tsToMs,
} from '@temporalio/common';
import {
  extractSpanContextFromHeaders,
  linkSpans,
  NUM_JOBS_ATTR_KEY,
  RUN_ID_ATTR_KEY,
  TASK_TOKEN_ATTR_KEY,
} from '@temporalio/common/lib/otel';

import { closeableGroupBy, mergeMapWithState } from './rxutils';
import { byteArrayToBuffer, toMB } from './utils';
import { Workflow, WorkflowCreator } from './workflow/interface';
import { WorkflowCodeBundler } from './workflow/bundler';
import { Activity } from './activity';
import { Logger } from './logger';
import * as errors from './errors';
import { childSpan, getTracer, instrument } from './tracing';
import { ActivityExecuteInput } from './interceptors';
import { Core, ReplayCore, History } from './core';
import { ThreadedVMWorkflowCreator } from './workflow/threaded-vm';
import { DeterminismViolationError, SinkCall, WorkflowInfo } from '@temporalio/workflow';
import {
  addDefaultWorkerOptions,
  CompiledWorkerOptions,
  compileWorkerOptions,
  isCodeBundleOption,
  isPathBundleOption,
  ReplayWorkerOptions,
  WorkerOptions,
} from './worker-options';
import { VMWorkflowCreator } from './workflow/vm';
import IWorkflowActivationJob = coresdk.workflow_activation.IWorkflowActivationJob;
import EvictionReason = coresdk.workflow_activation.RemoveFromCache.EvictionReason;
import IRemoveFromCache = coresdk.workflow_activation.IRemoveFromCache;

export { IllegalStateError } from '@temporalio/common';
export { DataConverter, defaultDataConverter, errors };

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
  formattedTaskToken: string;
}>;

export interface NativeWorkerLike {
  shutdown: Promisify<OmitFirstParam<typeof native.workerShutdown>>;
  completeShutdown(): Promise<void>;
  flushCoreLogs(): void;
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
  createReplay(options: CompiledWorkerOptions, history: History): Promise<NativeWorkerLike>;
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

  public static async createReplay(options: CompiledWorkerOptions, history: History): Promise<NativeWorkerLike> {
    const core = await ReplayCore.instance();
    const nativeWorker = await core.createReplayWorker(options, history);
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
  flushCoreLogs(): void {
    this.core.flushLogs();
  }

  public async completeShutdown(): Promise<void> {
    await this.core.deregisterWorker(this.nativeWorker);
  }

  public get namespace(): string {
    return this.core.options.serverOptions.namespace;
  }

  public get logger(): Logger {
    return this.core.logger;
  }
}

function formatTaskToken(taskToken: Uint8Array) {
  return Buffer.from(taskToken).toString('base64');
}

/**
 * The temporal worker connects to the service and runs workflows and activities.
 */
export class Worker {
  protected readonly activityHeartbeatSubject = new Subject<{
    taskToken: Uint8Array;
    details?: any;
  }>();
  protected readonly stateSubject = new BehaviorSubject<State>('INITIALIZED');
  protected readonly workflowPollerStateSubject = new BehaviorSubject<'POLLING' | 'SHUTDOWN' | 'FAILED'>('POLLING');
  protected readonly numInFlightActivationsSubject = new BehaviorSubject<number>(0);
  protected readonly numInFlightActivitiesSubject = new BehaviorSubject<number>(0);
  protected readonly numRunningWorkflowInstancesSubject = new BehaviorSubject<number>(0);
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

  /**
   * Create a new Worker.
   * This method initiates a connection to the server and will throw (asynchronously) on connection failure.
   */
  public static async create(options: WorkerOptions): Promise<Worker> {
    const nativeWorkerCtor: WorkerConstructor = this.nativeWorkerCtor;
    const compiledOptions = compileWorkerOptions(addDefaultWorkerOptions(options));
    const nativeWorker = await nativeWorkerCtor.create(compiledOptions);
    return await this.bundleWorker(compiledOptions, nativeWorker);
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
    const replayWorker = await nativeWorkerCtor.createReplay(compiledOptions, history);
    const constructedWorker = await this.bundleWorker(compiledOptions, replayWorker);

    const runPromise = constructedWorker.run();
    const pollerShutdown = firstValueFrom(
      constructedWorker.workflowPollerStateSubject.pipe(filter((state) => state !== 'POLLING'))
    );

    const evictionPromise = firstValueFrom(
      constructedWorker.evictionsSubject.pipe(
        // Ignore self-induced shutdowns, as they are a legit and we'll terminate normally.
        filter((ev) => ev.evictJob != this.SELF_INDUCED_SHUTDOWN_EVICTION),
        map((ev) => {
          if (ev.evictJob.reason === EvictionReason.NONDETERMINISM) {
            throw new DeterminismViolationError(
              'Replay failed with a nondeterminism error. This means that the workflow code as written ' +
                `is not compatible with the history that was fed in. Details: ${ev.evictJob.message}`
            );
          } else {
            throw new Error(`Replay failed. Details: ${ev.evictJob.message}`);
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

  protected static async bundleWorker(
    compiledOptions: CompiledWorkerOptions,
    nativeWorker: NativeWorkerLike
  ): Promise<Worker> {
    try {
      let bundle: string | undefined = undefined;
      let workflowCreator: WorkflowCreator | undefined = undefined;
      // nodeModulesPaths should not be undefined if workflowsPath is provided
      if (compiledOptions.workflowsPath && compiledOptions.nodeModulesPaths) {
        const bundler = new WorkflowCodeBundler(
          nativeWorker.logger,
          compiledOptions.nodeModulesPaths,
          compiledOptions.workflowsPath,
          compiledOptions.interceptors?.workflowModules
        );
        bundle = await bundler.createBundle();
        nativeWorker.logger.info('Workflow bundle created', { size: `${toMB(bundle.length)}MB` });
      } else if (compiledOptions.workflowBundle) {
        if (isCodeBundleOption(compiledOptions.workflowBundle)) {
          bundle = compiledOptions.workflowBundle.code;
        } else if (isPathBundleOption(compiledOptions.workflowBundle)) {
          bundle = await fs.readFile(compiledOptions.workflowBundle.path, 'utf8');
        } else {
          throw new TypeError('Invalid WorkflowOptions.workflowBundle');
        }
      }
      if (bundle) {
        if (compiledOptions.debugMode) {
          workflowCreator = await VMWorkflowCreator.create(bundle, compiledOptions.isolateExecutionTimeoutMs);
        } else {
          workflowCreator = await ThreadedVMWorkflowCreator.create({
            code: bundle,
            threadPoolSize: compiledOptions.workflowThreadPoolSize,
            isolateExecutionTimeoutMs: compiledOptions.isolateExecutionTimeoutMs,
          });
        }
      }
      return new this(nativeWorker, workflowCreator, compiledOptions);
    } catch (err) {
      // Deregister our worker in case Worker creation (Webpack) failed
      await nativeWorker.completeShutdown();
      throw err;
    }
  }

  /**
   * Create a new Worker from nativeWorker.
   */
  protected constructor(
    protected readonly nativeWorker: NativeWorkerLike,
    /**
     * Optional WorkflowCreator - if not provided, Worker will not poll on workflows
     */
    protected readonly workflowCreator: WorkflowCreator | undefined,
    public readonly options: CompiledWorkerOptions
  ) {
    this.tracer = getTracer(options.enableSDKTracing);
  }

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
   * An Observable which emits each time the number of cached workflows changes
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
                  | { type: 'result'; result: coresdk.activity_result.IActivityExecutionResult; parentSpan: otel.Span }
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
                    const activityId = info.activityId;
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
                      this.log.error('Tried to cancel a non-existing activity', { formattedTaskToken });
                      span.setAttribute('found', false);
                      break;
                    }
                    // NOTE: activity will not be considered cancelled until it confirms cancellation
                    this.log.debug('Cancelling activity', { formattedTaskToken });
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
            return await instrument(this.tracer, output.parentSpan, 'activity.run', async (span) => {
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
                activation: new coresdk.workflow_activation.WorkflowActivation({
                  runId: group$.key,
                  jobs: [{ removeFromCache: Worker.SELF_INDUCED_SHUTDOWN_EVICTION }],
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
                    numRunningWorkflowInstances: this.numRunningWorkflowInstancesSubject.value,
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
                      if (activation.timestamp === undefined) {
                        throw new TypeError('Got activation with no timestamp, cannot create a new Workflow instance');
                      }
                      const { workflowId, randomnessSeed, workflowType } = startWorkflow;
                      this.log.debug('Creating workflow', {
                        workflowType,
                        workflowId,
                        runId: activation.runId,
                      });
                      this.numRunningWorkflowInstancesSubject.next(this.numRunningWorkflowInstancesSubject.value + 1);
                      const workflowInfo = {
                        workflowType,
                        runId: activation.runId,
                        workflowId,
                        namespace: this.nativeWorker.namespace,
                        taskQueue: this.options.taskQueue,
                        isReplaying: activation.isReplaying,
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
                    const completion = await state.workflow.activate(activation);
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
                      await this.processSinkCalls(externalCalls, state.info);
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
                    failure: await errorToFailure(error, this.options.dataConverter),
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
   * Process extracted external calls from Workflow post activation.
   *
   * Each SinkCall is translated into a injected sink function call.
   *
   * This function does not throw, it will log in case of missing sinks
   * or failed sink function invocations.
   */
  protected async processSinkCalls(externalCalls: SinkCall[], info: WorkflowInfo): Promise<void> {
    const { sinks } = this.options;
    await Promise.all(
      externalCalls.map(async ({ ifaceName, fnName, args }) => {
        const dep = sinks?.[ifaceName]?.[fnName];
        if (dep === undefined) {
          this.log.error('Workflow referenced an unregistrered external sink', {
            ifaceName,
            fnName,
          });
        } else if (dep.callDuringReplay || !info.isReplaying) {
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
    return this.activityHeartbeatSubject.pipe(
      // The only way for this observable to be closed is by state changing to DRAINED meaning that all in-flight activities have been resolved and thus there should not be any heartbeats to send.
      this.takeUntilState('DRAINED'),
      tap({
        next: ({ taskToken }) => this.log.trace('Got activity heartbeat', { taskToken: formatTaskToken(taskToken) }),
        complete: () => this.log.debug('Heartbeats complete'),
      }),
      mergeMap(async ({ taskToken, details }) => {
        const payload = await this.options.dataConverter.toPayload(details);
        const arr = coresdk.ActivityHeartbeat.encodeDelimited({
          taskToken,
          details: [payload],
        }).finish();
        this.nativeWorker.recordActivityHeartbeat(byteArrayToBuffer(arr));
      })
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
          const buffer = await this.nativeWorker.pollWorkflowActivation(span.spanContext());
          const activation = coresdk.workflow_activation.WorkflowActivation.decode(new Uint8Array(buffer));
          const { runId, ...rest } = activation;
          this.log.debug('Got workflow activation', { runId, ...rest });

          span.setAttribute(RUN_ID_ATTR_KEY, runId).setAttribute(NUM_JOBS_ATTR_KEY, rest.jobs.length);
          await this.linkWorkflowSpans(runId, rest.jobs, parentSpan);

          return { activation, parentSpan };
        },
        (err) => err instanceof errors.ShutdownError
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
    if (this.workflowCreator === undefined) {
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
          const buffer = await this.nativeWorker.pollActivityTask(span.spanContext());
          const task = coresdk.activity_task.ActivityTask.decode(new Uint8Array(buffer));
          const { taskToken, ...rest } = task;
          const formattedTaskToken = formatTaskToken(taskToken);
          this.log.debug('Got activity task', { taskToken: formattedTaskToken, ...rest });
          const { variant } = task;
          if (variant === undefined) {
            throw new TypeError('Got an activity task without a "variant" attribute');
          }
          parentSpan.setAttributes({
            [TASK_TOKEN_ATTR_KEY]: formattedTaskToken,
            variant,
            [RUN_ID_ATTR_KEY]: task.start?.workflowExecution?.runId ?? 'unknown',
          });
          // If the activity had otel headers, link to that span
          if (task.start?.headerFields) {
            const ctx = await extractSpanContextFromHeaders(task.start.headerFields);
            linkSpans(parentSpan, ctx);
          }
          return { task, parentSpan, formattedTaskToken };
        },
        (err) => err instanceof errors.ShutdownError
      );
    });
  }

  protected activity$(): Observable<void> {
    // Note that we poll on activities even if there are no activities registered.
    // This is so workflows invoking activities on this task queue get a non-retriable error.
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
      throw new IllegalStateError('Poller was already started');
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
      // Only shutdown the native worker if we completed without an error.
      // Otherwise Rust / TS are in an unknown state and shutdown might hang.
      // A new process must be created in order to instantiate a new Rust Core.
      // TODO: force shutdown in core?
      await this.nativeWorker.completeShutdown();
    } finally {
      try {
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
  dataConverter: DataConverter,
  activityNamespace: string
): Promise<ActivityInfo> {
  // NOTE: We trust core to supply all of these fields instead of checking for null and undefined everywhere
  const { taskToken } = task as NonNullableObject<coresdk.activity_task.IActivityTask>;
  const start = task.start as NonNullableObject<coresdk.activity_task.IStart>;
  const activityId = start.activityId;
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
