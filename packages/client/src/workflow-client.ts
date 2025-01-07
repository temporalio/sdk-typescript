import { status as grpcStatus } from '@grpc/grpc-js';
import { v4 as uuid4 } from 'uuid';
import {
  BaseWorkflowHandle,
  CancelledFailure,
  compileRetryPolicy,
  mapToPayloads,
  HistoryAndWorkflowId,
  QueryDefinition,
  RetryState,
  searchAttributePayloadConverter,
  SignalDefinition,
  UpdateDefinition,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  WithWorkflowArgs,
  Workflow,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowResultType,
  extractWorkflowType,
  encodeWorkflowIdReusePolicy,
  decodeRetryState,
  encodeWorkflowIdConflictPolicy,
  WorkflowIdConflictPolicy,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { History } from '@temporalio/common/lib/proto-utils';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import {
  decodeArrayFromPayloads,
  decodeFromPayloadsAtIndex,
  decodeOptionalFailureToOptionalError,
  encodeMapToPayloads,
  encodeToPayloads,
  filterNullAndUndefined,
} from '@temporalio/common/lib/internal-non-workflow';
import { temporal } from '@temporalio/proto';
import {
  ServiceError,
  WorkflowContinuedAsNewError,
  WorkflowFailedError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  isGrpcServiceError,
} from './errors';
import {
  WorkflowCancelInput,
  WorkflowClientInterceptor,
  WorkflowClientInterceptors,
  WorkflowDescribeInput,
  WorkflowQueryInput,
  WorkflowSignalInput,
  WorkflowSignalWithStartInput,
  WorkflowStartInput,
  WorkflowTerminateInput,
  WorkflowStartUpdateInput,
  WorkflowStartUpdateOutput,
  WorkflowStartUpdateWithStartInput,
  WorkflowStartUpdateWithStartOutput,
} from './interceptors';
import {
  CountWorkflowExecution,
  DescribeWorkflowExecutionResponse,
  encodeQueryRejectCondition,
  GetWorkflowExecutionHistoryRequest,
  QueryRejectCondition,
  RequestCancelWorkflowExecutionResponse,
  StartWorkflowExecutionRequest,
  TerminateWorkflowExecutionResponse,
  WorkflowExecution,
  WorkflowExecutionDescription,
  WorkflowExecutionInfo,
  WorkflowService,
} from './types';
import {
  compileWorkflowOptions,
  WorkflowOptions,
  WorkflowSignalWithStartOptions,
  WorkflowStartOptions,
  WorkflowUpdateOptions,
} from './workflow-options';
import { decodeCountWorkflowExecutionsResponse, executionInfoFromRaw, rethrowKnownErrorTypes } from './helpers';
import {
  BaseClient,
  BaseClientOptions,
  defaultBaseClientOptions,
  LoadedWithDefaults,
  WithDefaults,
} from './base-client';
import { mapAsyncIterable } from './iterators-utils';
import { WorkflowUpdateStage, encodeWorkflowUpdateStage } from './workflow-update-stage';

const UpdateWorkflowExecutionLifecycleStage = temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage;

/**
 * A client side handle to a single Workflow instance.
 * It can be used to start, signal, query, wait for completion, terminate and cancel a Workflow execution.
 *
 * Given the following Workflow definition:
 * ```ts
 * export const incrementSignal = defineSignal<[number]>('increment');
 * export const getValueQuery = defineQuery<number>('getValue');
 * export const incrementAndGetValueUpdate = defineUpdate<number, [number]>('incrementAndGetValue');
 * export async function counterWorkflow(initialValue: number): Promise<void>;
 * ```
 *
 * Create a handle for running and interacting with a single Workflow:
 * ```ts
 * const client = new WorkflowClient();
 * // Start the Workflow with initialValue of 2.
 * const handle = await client.start({
 *   workflowType: counterWorkflow,
 *   args: [2],
 *   taskQueue: 'tutorial',
 * });
 * await handle.signal(incrementSignal, 2);
 * const queryResult = await handle.query(getValueQuery); // 4
 * const firstUpdateResult = await handle.executeUpdate(incrementAndGetValueUpdate, { args: [2] }); // 6
 * const secondUpdateHandle = await handle.startUpdate(incrementAndGetValueUpdate, { args: [2] });
 * const secondUpdateResult = await secondUpdateHandle.result(); // 8
 * await handle.cancel();
 * await handle.result(); // throws a WorkflowFailedError with `cause` set to a CancelledFailure.
 * ```
 */
export interface WorkflowHandle<T extends Workflow = Workflow> extends BaseWorkflowHandle<T> {
  /**
   * Start an Update and wait for the result.
   *
   * @throws {@link WorkflowUpdateFailedError} if Update validation fails or if ApplicationFailure is thrown in the Update handler.
   * @throws {@link WorkflowUpdateRPCTimeoutOrCancelledError} if this Update call timed out or was cancelled. This doesn't
   *  mean the update itself was timed out or cancelled.
   * @param def an Update definition as returned from {@link defineUpdate}
   * @param options Update arguments
   *
   * @example
   * ```ts
   * const updateResult = await handle.executeUpdate(incrementAndGetValueUpdate, { args: [2] });
   * ```
   */
  executeUpdate<Ret, Args extends [any, ...any[]], Name extends string = string>(
    def: UpdateDefinition<Ret, Args, Name> | string,
    options: WorkflowUpdateOptions & { args: Args }
  ): Promise<Ret>;

  executeUpdate<Ret, Args extends [], Name extends string = string>(
    def: UpdateDefinition<Ret, Args, Name> | string,
    options?: WorkflowUpdateOptions & { args?: Args }
  ): Promise<Ret>;

  /**
   * Start an Update and receive a handle to the Update. The Update validator (if present) is run
   * before the handle is returned.
   *
   * @throws {@link WorkflowUpdateFailedError} if Update validation fails.
   * @throws {@link WorkflowUpdateRPCTimeoutOrCancelledError} if this Update call timed out or was cancelled. This doesn't
   *  mean the update itself was timed out or cancelled.
   *
   * @param def an Update definition as returned from {@link defineUpdate}
   * @param options update arguments, and update lifecycle stage to wait for
   *
   * Currently, startUpdate always waits until a worker is accepting tasks for the workflow and the
   * update is accepted or rejected, and the options object must be at least
   * ```ts
   * {
   *   waitForStage: WorkflowUpdateStage.ACCEPTED
   * }
   * ```
   * If the update takes arguments, then the options object must additionally contain an `args`
   * property with an array of argument values.
   *
   * @example
   * ```ts
   * const updateHandle = await handle.startUpdate(incrementAndGetValueUpdate, {
   *   args: [2],
   *   waitForStage: 'ACCEPTED',
   * });
   * const updateResult = await updateHandle.result();
   * ```
   */
  startUpdate<Ret, Args extends [any, ...any[]], Name extends string = string>(
    def: UpdateDefinition<Ret, Args, Name> | string,
    options: WorkflowUpdateOptions & {
      args: Args;
      waitForStage: 'ACCEPTED';
    }
  ): Promise<WorkflowUpdateHandle<Ret>>;

  startUpdate<Ret, Args extends [], Name extends string = string>(
    def: UpdateDefinition<Ret, Args, Name> | string,
    options: WorkflowUpdateOptions & {
      args?: Args;
      waitForStage: typeof WorkflowUpdateStage.ACCEPTED;
    }
  ): Promise<WorkflowUpdateHandle<Ret>>;

  /**
   * Get a handle to an Update of this Workflow.
   */
  getUpdateHandle<Ret>(updateId: string): WorkflowUpdateHandle<Ret>;

  /**
   * Query a running or completed Workflow.
   *
   * @param def a query definition as returned from {@link defineQuery} or query name (string)
   *
   * @example
   * ```ts
   * await handle.query(getValueQuery);
   * await handle.query<number, []>('getValue');
   * ```
   */
  query<Ret, Args extends any[] = []>(def: QueryDefinition<Ret, Args> | string, ...args: Args): Promise<Ret>;

  /**
   * Terminate a running Workflow
   */
  terminate(reason?: string): Promise<TerminateWorkflowExecutionResponse>;

  /**
   * Cancel a running Workflow.
   *
   * When a Workflow is cancelled, the root scope throws {@link CancelledFailure} with `message: 'Workflow canceled'`.
   * That means that all cancellable scopes will throw `CancelledFailure`.
   *
   * Cancellation may be propagated to Activities depending on {@link ActivityOptions#cancellationType}, after which
   * Activity calls may throw an {@link ActivityFailure}, and `isCancellation(error)` will be true (see {@link isCancellation}).
   *
   * Cancellation may be propagated to Child Workflows depending on {@link ChildWorkflowOptions#cancellationType}, after
   * which calls to {@link executeChild} and {@link ChildWorkflowHandle#result} will throw, and `isCancellation(error)`
   * will be true (see {@link isCancellation}).
   */
  cancel(): Promise<RequestCancelWorkflowExecutionResponse>;

  /**
   * Describe the current workflow execution
   */
  describe(): Promise<WorkflowExecutionDescription>;

  /**
   * Return a workflow execution's history
   */
  fetchHistory(): Promise<History>;

  /**
   * Readonly accessor to the underlying WorkflowClient
   */
  readonly client: WorkflowClient;
}

/**
 * This interface is exactly the same as {@link WorkflowHandle} except it
 * includes the `firstExecutionRunId` returned from {@link WorkflowClient.start}.
 */
export interface WorkflowHandleWithFirstExecutionRunId<T extends Workflow = Workflow> extends WorkflowHandle<T> {
  /**
   * Run Id of the first Execution in the Workflow Execution Chain.
   */
  readonly firstExecutionRunId: string;
}

/**
 * This interface is exactly the same as {@link WorkflowHandle} except it
 * includes the `signaledRunId` returned from `signalWithStart`.
 */
export interface WorkflowHandleWithSignaledRunId<T extends Workflow = Workflow> extends WorkflowHandle<T> {
  /**
   * The Run Id of the bound Workflow at the time of {@link WorkflowClient.signalWithStart}.
   *
   * Since `signalWithStart` may have signaled an existing Workflow Chain, `signaledRunId` might not be the
   * `firstExecutionRunId`.
   */
  readonly signaledRunId: string;
}

export interface WorkflowClientOptions extends BaseClientOptions {
  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  // eslint-disable-next-line deprecation/deprecation
  interceptors?: WorkflowClientInterceptors | WorkflowClientInterceptor[];

  /**
   * Should a query be rejected by closed and failed workflows
   *
   * @default `undefined` which means that closed and failed workflows are still queryable
   */
  queryRejectCondition?: QueryRejectCondition;
}

export type LoadedWorkflowClientOptions = LoadedWithDefaults<WorkflowClientOptions>;

function defaultWorkflowClientOptions(): WithDefaults<WorkflowClientOptions> {
  return {
    ...defaultBaseClientOptions(),
    interceptors: [],
    queryRejectCondition: 'NONE',
  };
}

function assertRequiredWorkflowOptions(opts: WorkflowOptions): asserts opts is WorkflowOptions {
  if (!opts.taskQueue) {
    throw new TypeError('Missing WorkflowOptions.taskQueue');
  }
  if (!opts.workflowId) {
    throw new TypeError('Missing WorkflowOptions.workflowId');
  }
}

function ensureArgs<W extends Workflow, T extends WorkflowStartOptions<W>>(
  opts: T
): Omit<T, 'args'> & { args: unknown[] } {
  const { args, ...rest } = opts;
  return { args: (args as unknown[]) ?? [], ...rest };
}

/**
 * Options for getting a result of a Workflow execution.
 */
export interface WorkflowResultOptions {
  /**
   * If set to true, instructs the client to follow the chain of execution before returning a Workflow's result.
   *
   * Workflow execution is chained if the Workflow has a cron schedule or continues-as-new or configured to retry
   * after failure or timeout.
   *
   * @default true
   */
  followRuns?: boolean;
}

/**
 * Options for {@link WorkflowClient.getHandle}
 */
export interface GetWorkflowHandleOptions extends WorkflowResultOptions {
  /**
   * ID of the first execution in the Workflow execution chain.
   *
   * When getting a handle with no `runId`, pass this option to ensure some
   * {@link WorkflowHandle} methods (e.g. `terminate` and `cancel`) don't
   * affect executions from another chain.
   */
  firstExecutionRunId?: string;
}

interface WorkflowHandleOptions extends GetWorkflowHandleOptions {
  workflowId: string;
  runId?: string;
  interceptors: WorkflowClientInterceptor[];
  /**
   * A runId to use for getting the workflow's result.
   *
   * - When creating a handle using `getHandle`, uses the provided runId or firstExecutionRunId
   * - When creating a handle using `start`, uses the returned runId (first in the chain)
   * - When creating a handle using `signalWithStart`, uses the the returned runId
   */
  runIdForResult?: string;
}

/**
 * An iterable list of WorkflowExecution, as returned by {@link WorkflowClient.list}.
 */
export interface AsyncWorkflowListIterable extends AsyncIterable<WorkflowExecutionInfo> {
  /**
   * Return an iterable of histories corresponding to this iterable's WorkflowExecutions.
   * Workflow histories will be fetched concurrently.
   *
   * Useful in batch replaying
   */
  intoHistories: (intoHistoriesOptions?: IntoHistoriesOptions) => AsyncIterable<HistoryAndWorkflowId>;
}

/**
 * A client-side handle to an Update.
 */
export interface WorkflowUpdateHandle<Ret> {
  /**
   * The ID of this Update request.
   */
  updateId: string;

  /**
   * The ID of the Workflow being targeted by this Update request.
   */
  workflowId: string;

  /**
   * The ID of the Run of the Workflow being targeted by this Update request.
   */
  workflowRunId?: string;

  /**
   * Return the result of the Update.
   * @throws {@link WorkflowUpdateFailedError} if ApplicationFailure is thrown in the Update handler.
   */
  result(): Promise<Ret>;
}

/**
 * Options for {@link WorkflowHandle.getUpdateHandle}
 */
export interface GetWorkflowUpdateHandleOptions {
  /**
   * The ID of the Run of the Workflow targeted by the Update.
   */
  workflowRunId?: string;
}

/**
 * Options for {@link WorkflowClient.list}
 */
export interface ListOptions {
  /**
   * Maximum number of results to fetch per page.
   *
   * @default depends on server config, typically 1000
   */
  pageSize?: number;
  /**
   * Query string for matching and ordering the results
   */
  query?: string;
}

/**
 * Options for {@link WorkflowClient.list().intoHistories()}
 */
export interface IntoHistoriesOptions {
  /**
   * Maximum number of workflow histories to download concurrently.
   *
   * @default 5
   */
  concurrency?: number;

  /**
   * Maximum number of workflow histories to buffer ahead, ready for consumption.
   *
   * It is recommended to set `bufferLimit` to a rasonnably low number if it is expected that the
   * iterable may be stopped before reaching completion (for example, when implementing a fail fast
   * bach replay test).
   *
   * Ignored unless `concurrency > 1`. No limit applies if set to `undefined`.
   *
   * @default unlimited
   */
  bufferLimit?: number;
}

const withStartWorkflowOperationResolve: unique symbol = Symbol();
const withStartWorkflowOperationReject: unique symbol = Symbol();
const withStartWorkflowOperationUsed: unique symbol = Symbol();

/**
 * Define how to start a workflow when using {@link WorkflowClient.startUpdateWithStart} and
 * {@link WorkflowClient.executeUpdateWithStart}. `workflowIdConflictPolicy` is required in the options.
 *
 * @experimental Update-with-Start is an experimental feature and may be subject to change.
 */
export class WithStartWorkflowOperation<T extends Workflow> {
  private [withStartWorkflowOperationUsed]: boolean = false;
  private [withStartWorkflowOperationResolve]: ((handle: WorkflowHandle<T>) => void) | undefined = undefined;
  private [withStartWorkflowOperationReject]: ((error: any) => void) | undefined = undefined;
  private workflowHandlePromise: Promise<WorkflowHandle<T>>;

  constructor(
    public workflowTypeOrFunc: string | T,
    public options: WorkflowStartOptions<T> & { workflowIdConflictPolicy: WorkflowIdConflictPolicy }
  ) {
    this.workflowHandlePromise = new Promise<WorkflowHandle<T>>((resolve, reject) => {
      this[withStartWorkflowOperationResolve] = resolve;
      this[withStartWorkflowOperationReject] = reject;
    });
  }

  public async workflowHandle(): Promise<WorkflowHandle<T>> {
    return await this.workflowHandlePromise;
  }
}

/**
 * Client for starting Workflow executions and creating Workflow handles.
 *
 * Typically this client should not be instantiated directly, instead create the high level {@link Client} and use
 * {@link Client.workflow} to interact with Workflows.
 */
export class WorkflowClient extends BaseClient {
  public readonly options: LoadedWorkflowClientOptions;

  constructor(options?: WorkflowClientOptions) {
    super(options);
    this.options = {
      ...defaultWorkflowClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter: this.dataConverter,
    };
  }

  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made via this service
   * object.
   */
  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }

  protected async _start<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    options: WithWorkflowArgs<T, WorkflowOptions>,
    interceptors: WorkflowClientInterceptor[]
  ): Promise<string> {
    const workflowType = extractWorkflowType(workflowTypeOrFunc);
    assertRequiredWorkflowOptions(options);
    const compiledOptions = compileWorkflowOptions(ensureArgs(options));

    const start = composeInterceptors(interceptors, 'start', this._startWorkflowHandler.bind(this));

    return start({
      options: compiledOptions,
      headers: {},
      workflowType,
    });
  }

  protected async _signalWithStart<T extends Workflow, SA extends any[]>(
    workflowTypeOrFunc: string | T,
    options: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SA>>,
    interceptors: WorkflowClientInterceptor[]
  ): Promise<string> {
    const workflowType = extractWorkflowType(workflowTypeOrFunc);
    const { signal, signalArgs, ...rest } = options;
    assertRequiredWorkflowOptions(rest);
    const compiledOptions = compileWorkflowOptions(ensureArgs(rest));

    const signalWithStart = composeInterceptors(
      interceptors,
      'signalWithStart',
      this._signalWithStartWorkflowHandler.bind(this)
    );

    return signalWithStart({
      options: compiledOptions,
      headers: {},
      workflowType,
      signalName: typeof signal === 'string' ? signal : signal.name,
      signalArgs: signalArgs ?? [],
    });
  }

  /**
   * Start a new Workflow execution.
   *
   * @returns a {@link WorkflowHandle} to the started Workflow
   */
  public async start<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    options: WorkflowStartOptions<T>
  ): Promise<WorkflowHandleWithFirstExecutionRunId<T>> {
    const { workflowId } = options;
    const interceptors = this.getOrMakeInterceptors(workflowId);
    const runId = await this._start(workflowTypeOrFunc, { ...options, workflowId }, interceptors);
    // runId is not used in handles created with `start*` calls because these
    // handles should allow interacting with the workflow if it continues as new.
    const handle = this._createWorkflowHandle({
      workflowId,
      runId: undefined,
      firstExecutionRunId: runId,
      runIdForResult: runId,
      interceptors,
      followRuns: options.followRuns ?? true,
    }) as WorkflowHandleWithFirstExecutionRunId<T>; // Cast is safe because we know we add the firstExecutionRunId below
    (handle as any) /* readonly */.firstExecutionRunId = runId;
    return handle;
  }

  /**
   * Start a new Workflow Execution and immediately send a Signal to that Workflow.
   *
   * The behavior of Signal-with-Start in the case where there is already a running Workflow with
   * the given Workflow ID depends on the {@link WorkflowIDConflictPolicy}. That is, if the policy
   * is `USE_EXISTING`, then the Signal is issued against the already existing Workflow Execution;
   * however, if the policy is `FAIL`, then an error is thrown. If no policy is specified,
   * Signal-with-Start defaults to `USE_EXISTING`.
   *
   * @returns a {@link WorkflowHandle} to the started Workflow
   */
  public async signalWithStart<WorkflowFn extends Workflow, SignalArgs extends any[] = []>(
    workflowTypeOrFunc: string | WorkflowFn,
    options: WithWorkflowArgs<WorkflowFn, WorkflowSignalWithStartOptions<SignalArgs>>
  ): Promise<WorkflowHandleWithSignaledRunId<WorkflowFn>> {
    const { workflowId } = options;
    const interceptors = this.getOrMakeInterceptors(workflowId);
    const runId = await this._signalWithStart(workflowTypeOrFunc, options, interceptors);
    // runId is not used in handles created with `start*` calls because these
    // handles should allow interacting with the workflow if it continues as new.
    const handle = this._createWorkflowHandle({
      workflowId,
      runId: undefined,
      firstExecutionRunId: undefined, // We don't know if this runId is first in the chain or not
      runIdForResult: runId,
      interceptors,
      followRuns: options.followRuns ?? true,
    }) as WorkflowHandleWithSignaledRunId<WorkflowFn>; // Cast is safe because we know we add the signaledRunId below
    (handle as any) /* readonly */.signaledRunId = runId;
    return handle;
  }

  /**
   * Start a new Workflow Execution and immediately send an Update to that Workflow,
   * then await and return the Update's result.
   *
   * The `updateOptions` object must contain a {@link WithStartWorkflowOperation}, which defines
   * the options for the Workflow execution to start (e.g. the Workflow's type, task queue, input
   * arguments, etc.)
   *
   * The behavior of Update-with-Start in the case where there is already a running Workflow with
   * the given Workflow ID depends on the specified {@link WorkflowIDConflictPolicy}. That is, if
   * the policy is `USE_EXISTING`, then the Update is issued against the already existing Workflow
   * Execution; however, if the policy is `FAIL`, then an error is thrown. Caller MUST specify
   * the desired WorkflowIDConflictPolicy.
   *
   * This call will block until the Update has completed. The Workflow handle can be retrieved by
   * awaiting on {@link WithStartWorkflowOperation.workflowHandle}, whether or not the Update
   * succeeds.
   *
   * @returns the Update result
   *
   * @experimental Update-with-Start is an experimental feature and may be subject to change.
   */
  public async executeUpdateWithStart<T extends Workflow, Ret, Args extends any[]>(
    updateDef: UpdateDefinition<Ret, Args> | string,
    updateOptions: WorkflowUpdateOptions & { args?: Args; startWorkflowOperation: WithStartWorkflowOperation<T> }
  ): Promise<Ret> {
    const handle = await this._startUpdateWithStart(updateDef, {
      ...updateOptions,
      waitForStage: WorkflowUpdateStage.COMPLETED,
    });
    return await handle.result();
  }

  /**
   * Start a new Workflow Execution and immediately send an Update to that Workflow,
   * then return a {@link WorkflowUpdateHandle} for that Update.
   *
   * The `updateOptions` object must contain a {@link WithStartWorkflowOperation}, which defines
   * the options for the Workflow execution to start (e.g. the Workflow's type, task queue, input
   * arguments, etc.)
   *
   * The behavior of Update-with-Start in the case where there is already a running Workflow with
   * the given Workflow ID depends on the specified {@link WorkflowIDConflictPolicy}. That is, if
   * the policy is `USE_EXISTING`, then the Update is issued against the already existing Workflow
   * Execution; however, if the policy is `FAIL`, then an error is thrown. Caller MUST specify
   * the desired WorkflowIDConflictPolicy.
   *
   * This call will block until the Update has reached the specified {@link WorkflowUpdateStage}.
   * Note that this means that the call will not return successfully until the Update has
   * been delivered to a Worker. The Workflow handle can be retrieved by awaiting on
   * {@link WithStartWorkflowOperation.workflowHandle}, whether or not the Update succeeds.
   *
   * @returns a {@link WorkflowUpdateHandle} to the started Update
   *
   * @experimental Update-with-Start is an experimental feature and may be subject to change.
   */
  public async startUpdateWithStart<T extends Workflow, Ret, Args extends any[]>(
    updateDef: UpdateDefinition<Ret, Args> | string,
    updateOptions: WorkflowUpdateOptions & {
      args?: Args;
      waitForStage: 'ACCEPTED';
      startWorkflowOperation: WithStartWorkflowOperation<T>;
    }
  ): Promise<WorkflowUpdateHandle<Ret>> {
    return this._startUpdateWithStart(updateDef, updateOptions);
  }

  protected async _startUpdateWithStart<T extends Workflow, Ret, Args extends any[]>(
    updateDef: UpdateDefinition<Ret, Args> | string,
    updateWithStartOptions: WorkflowUpdateOptions & {
      args?: Args;
      waitForStage: WorkflowUpdateStage;
      startWorkflowOperation: WithStartWorkflowOperation<T>;
    }
  ): Promise<WorkflowUpdateHandle<Ret>> {
    const { waitForStage, args, startWorkflowOperation, ...updateOptions } = updateWithStartOptions;
    const { workflowTypeOrFunc, options: workflowOptions } = startWorkflowOperation;
    const { workflowId } = workflowOptions;

    if (startWorkflowOperation[withStartWorkflowOperationUsed]) {
      throw new Error('This WithStartWorkflowOperation instance has already been executed.');
    }
    startWorkflowOperation[withStartWorkflowOperationUsed] = true;
    assertRequiredWorkflowOptions(workflowOptions);

    const startUpdateWithStartInput: WorkflowStartUpdateWithStartInput = {
      workflowType: extractWorkflowType(workflowTypeOrFunc),
      workflowStartOptions: compileWorkflowOptions(ensureArgs(workflowOptions)),
      workflowStartHeaders: {},
      updateName: typeof updateDef === 'string' ? updateDef : updateDef.name,
      updateArgs: args ?? [],
      updateOptions,
      updateHeaders: {},
    };

    const interceptors = this.getOrMakeInterceptors(workflowId);

    const onStart = (startResponse: temporal.api.workflowservice.v1.IStartWorkflowExecutionResponse) =>
      startWorkflowOperation[withStartWorkflowOperationResolve]!(
        this._createWorkflowHandle({
          workflowId,
          firstExecutionRunId: startResponse.runId ?? undefined,
          interceptors,
          followRuns: workflowOptions.followRuns ?? true,
        })
      );

    const onStartError = (err: any) => {
      startWorkflowOperation[withStartWorkflowOperationReject]!(err);
    };

    const fn = composeInterceptors(
      interceptors,
      'startUpdateWithStart',
      this._updateWithStartHandler.bind(this, waitForStage, onStart, onStartError)
    );
    const updateOutput = await fn(startUpdateWithStartInput);

    let outcome = updateOutput.updateOutcome;
    if (!outcome && waitForStage === WorkflowUpdateStage.COMPLETED) {
      outcome = await this._pollForUpdateOutcome(updateOutput.updateId, {
        workflowId,
        runId: updateOutput.workflowExecution.runId,
      });
    }

    return this.createWorkflowUpdateHandle<Ret>(
      updateOutput.updateId,
      workflowId,
      updateOutput.workflowExecution.runId,
      outcome
    );
  }

  /**
   * Start a new Workflow execution, then await for its completion and return that Workflow's result.
   *
   * @returns the result of the Workflow execution
   */
  public async execute<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    options: WorkflowStartOptions<T>
  ): Promise<WorkflowResultType<T>> {
    const { workflowId } = options;
    const interceptors = this.getOrMakeInterceptors(workflowId);
    await this._start(workflowTypeOrFunc, options, interceptors);
    return await this.result(workflowId, undefined, {
      ...options,
      followRuns: options.followRuns ?? true,
    });
  }

  /**
   * Get the result of a Workflow execution.
   *
   * Follow the chain of execution in case Workflow continues as new, or has a cron schedule or retry policy.
   */
  public async result<T extends Workflow>(
    workflowId: string,
    runId?: string,
    opts?: WorkflowResultOptions
  ): Promise<WorkflowResultType<T>> {
    const followRuns = opts?.followRuns ?? true;
    const execution: temporal.api.common.v1.IWorkflowExecution = { workflowId, runId };
    const req: GetWorkflowExecutionHistoryRequest = {
      namespace: this.options.namespace,
      execution,
      skipArchival: true,
      waitNewEvent: true,
      historyEventFilterType: temporal.api.enums.v1.HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT,
    };
    let ev: temporal.api.history.v1.IHistoryEvent;

    for (;;) {
      let res: temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse;
      try {
        res = await this.workflowService.getWorkflowExecutionHistory(req);
      } catch (err) {
        this.rethrowGrpcError(err, 'Failed to get Workflow execution history', { workflowId, runId });
      }
      const events = res.history?.events;

      if (events == null || events.length === 0) {
        req.nextPageToken = res.nextPageToken;
        continue;
      }
      if (events.length !== 1) {
        throw new Error(`Expected at most 1 close event(s), got: ${events.length}`);
      }
      ev = events[0];

      if (ev.workflowExecutionCompletedEventAttributes) {
        if (followRuns && ev.workflowExecutionCompletedEventAttributes.newExecutionRunId) {
          execution.runId = ev.workflowExecutionCompletedEventAttributes.newExecutionRunId;
          req.nextPageToken = undefined;
          continue;
        }
        // Note that we can only return one value from our workflow function in JS.
        // Ignore any other payloads in result
        const [result] = await decodeArrayFromPayloads(
          this.dataConverter,
          ev.workflowExecutionCompletedEventAttributes.result?.payloads
        );
        return result as any;
      } else if (ev.workflowExecutionFailedEventAttributes) {
        if (followRuns && ev.workflowExecutionFailedEventAttributes.newExecutionRunId) {
          execution.runId = ev.workflowExecutionFailedEventAttributes.newExecutionRunId;
          req.nextPageToken = undefined;
          continue;
        }
        const { failure, retryState } = ev.workflowExecutionFailedEventAttributes;
        throw new WorkflowFailedError(
          'Workflow execution failed',
          await decodeOptionalFailureToOptionalError(this.dataConverter, failure),
          decodeRetryState(retryState)
        );
      } else if (ev.workflowExecutionCanceledEventAttributes) {
        const failure = new CancelledFailure(
          'Workflow canceled',
          await decodeArrayFromPayloads(
            this.dataConverter,
            ev.workflowExecutionCanceledEventAttributes.details?.payloads
          )
        );
        failure.stack = '';
        throw new WorkflowFailedError('Workflow execution cancelled', failure, RetryState.NON_RETRYABLE_FAILURE);
      } else if (ev.workflowExecutionTerminatedEventAttributes) {
        const failure = new TerminatedFailure(
          ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated'
        );
        failure.stack = '';
        throw new WorkflowFailedError(
          ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated',
          failure,
          RetryState.NON_RETRYABLE_FAILURE
        );
      } else if (ev.workflowExecutionTimedOutEventAttributes) {
        if (followRuns && ev.workflowExecutionTimedOutEventAttributes.newExecutionRunId) {
          execution.runId = ev.workflowExecutionTimedOutEventAttributes.newExecutionRunId;
          req.nextPageToken = undefined;
          continue;
        }
        const failure = new TimeoutFailure('Workflow execution timed out', undefined, TimeoutType.START_TO_CLOSE);
        failure.stack = '';
        throw new WorkflowFailedError(
          'Workflow execution timed out',
          failure,
          decodeRetryState(ev.workflowExecutionTimedOutEventAttributes.retryState)
        );
      } else if (ev.workflowExecutionContinuedAsNewEventAttributes) {
        const { newExecutionRunId } = ev.workflowExecutionContinuedAsNewEventAttributes;
        if (!newExecutionRunId) {
          throw new TypeError('Expected service to return newExecutionRunId for WorkflowExecutionContinuedAsNewEvent');
        }
        if (!followRuns) {
          throw new WorkflowContinuedAsNewError('Workflow execution continued as new', newExecutionRunId);
        }
        execution.runId = newExecutionRunId;
        req.nextPageToken = undefined;
        continue;
      }
    }
  }

  protected rethrowUpdateGrpcError(
    err: unknown,
    fallbackMessage: string,
    workflowExecution?: WorkflowExecution
  ): never {
    if (isGrpcServiceError(err)) {
      if (err.code === grpcStatus.DEADLINE_EXCEEDED || err.code === grpcStatus.CANCELLED) {
        throw new WorkflowUpdateRPCTimeoutOrCancelledError(err.details ?? 'Workflow update call timeout or cancelled', {
          cause: err,
        });
      }
    }

    if (err instanceof CancelledFailure) {
      throw new WorkflowUpdateRPCTimeoutOrCancelledError(err.message ?? 'Workflow update call timeout or cancelled', {
        cause: err,
      });
    }

    this.rethrowGrpcError(err, fallbackMessage, workflowExecution);
  }

  protected rethrowGrpcError(err: unknown, fallbackMessage: string, workflowExecution?: WorkflowExecution): never {
    if (isGrpcServiceError(err)) {
      rethrowKnownErrorTypes(err);

      if (err.code === grpcStatus.NOT_FOUND) {
        throw new WorkflowNotFoundError(
          err.details ?? 'Workflow not found',
          workflowExecution?.workflowId ?? '',
          workflowExecution?.runId
        );
      }

      throw new ServiceError(fallbackMessage, { cause: err });
    }
    throw new ServiceError('Unexpected error while making gRPC request', { cause: err as Error });
  }

  /**
   * Use given input to make a queryWorkflow call to the service
   *
   * Used as the final function of the query interceptor chain
   */
  protected async _queryWorkflowHandler(input: WorkflowQueryInput): Promise<unknown> {
    const req: temporal.api.workflowservice.v1.IQueryWorkflowRequest = {
      queryRejectCondition: input.queryRejectCondition,
      namespace: this.options.namespace,
      execution: input.workflowExecution,
      query: {
        queryType: input.queryType,
        queryArgs: { payloads: await encodeToPayloads(this.dataConverter, ...input.args) },
        header: { fields: input.headers },
      },
    };
    let response: temporal.api.workflowservice.v1.QueryWorkflowResponse;
    try {
      response = await this.workflowService.queryWorkflow(req);
    } catch (err) {
      if (isGrpcServiceError(err)) {
        rethrowKnownErrorTypes(err);
        if (err.code === grpcStatus.INVALID_ARGUMENT) {
          throw new QueryNotRegisteredError(err.message.replace(/^3 INVALID_ARGUMENT: /, ''), err.code);
        }
      }
      this.rethrowGrpcError(err, 'Failed to query Workflow', input.workflowExecution);
    }
    if (response.queryRejected) {
      if (response.queryRejected.status === undefined || response.queryRejected.status === null) {
        throw new TypeError('Received queryRejected from server with no status');
      }
      throw new QueryRejectedError(response.queryRejected.status);
    }
    if (!response.queryResult) {
      throw new TypeError('Invalid response from server');
    }
    // We ignore anything but the first result
    return await decodeFromPayloadsAtIndex(this.dataConverter, 0, response.queryResult?.payloads);
  }

  protected async _createUpdateWorkflowRequest(
    lifecycleStage: temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage,
    input: WorkflowStartUpdateInput
  ): Promise<temporal.api.workflowservice.v1.IUpdateWorkflowExecutionRequest> {
    const updateId = input.options?.updateId ?? uuid4();
    return {
      namespace: this.options.namespace,
      workflowExecution: input.workflowExecution,
      firstExecutionRunId: input.firstExecutionRunId,
      waitPolicy: {
        lifecycleStage,
      },
      request: {
        meta: {
          updateId,
          identity: this.options.identity,
        },
        input: {
          header: { fields: input.headers },
          name: input.updateName,
          args: { payloads: await encodeToPayloads(this.dataConverter, ...input.args) },
        },
      },
    };
  }

  /**
   * Start the Update.
   *
   * Used as the final function of the interceptor chain during startUpdate and executeUpdate.
   */
  protected async _startUpdateHandler(
    waitForStage: WorkflowUpdateStage,
    input: WorkflowStartUpdateInput
  ): Promise<WorkflowStartUpdateOutput> {
    let waitForStageProto: temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage =
      encodeWorkflowUpdateStage(waitForStage) ??
      UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED;

    waitForStageProto =
      waitForStageProto >= UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED
        ? waitForStageProto
        : UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED;

    const request = await this._createUpdateWorkflowRequest(waitForStageProto, input);

    // Repeatedly send UpdateWorkflowExecution until update is durable (if the server receives a request with
    // an update ID that already exists, it responds with information for the existing update). If the
    // requested wait stage is COMPLETED, further polling is done before returning the UpdateHandle.
    let response: temporal.api.workflowservice.v1.UpdateWorkflowExecutionResponse;
    try {
      do {
        response = await this.workflowService.updateWorkflowExecution(request);
      } while (
        response.stage < UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED
      );
    } catch (err) {
      this.rethrowUpdateGrpcError(err, 'Workflow Update failed', input.workflowExecution);
    }
    return {
      updateId: request.request!.meta!.updateId!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      workflowRunId: response.updateRef!.workflowExecution!.runId!,
      outcome: response.outcome ?? undefined,
    };
  }

  /**
   * Send the Update-With-Start MultiOperation request.
   *
   * Used as the final function of the interceptor chain during
   * startUpdateWithStart and executeUpdateWithStart.
   */
  protected async _updateWithStartHandler(
    waitForStage: WorkflowUpdateStage,
    onStart: (startResponse: temporal.api.workflowservice.v1.IStartWorkflowExecutionResponse) => void,
    onStartError: (err: any) => void,
    input: WorkflowStartUpdateWithStartInput
  ): Promise<WorkflowStartUpdateWithStartOutput> {
    const startInput: WorkflowStartInput = {
      workflowType: input.workflowType,
      options: input.workflowStartOptions,
      headers: input.workflowStartHeaders,
    };
    const updateInput: WorkflowStartUpdateInput = {
      updateName: input.updateName,
      args: input.updateArgs,
      workflowExecution: {
        workflowId: input.workflowStartOptions.workflowId,
      },
      options: input.updateOptions,
      headers: input.updateHeaders,
    };
    let seenStart = false;
    try {
      const startRequest = await this.createStartWorkflowRequest(startInput);
      const waitForStageProto = encodeWorkflowUpdateStage(waitForStage)!;
      const updateRequest = await this._createUpdateWorkflowRequest(waitForStageProto, updateInput);
      const multiOpReq: temporal.api.workflowservice.v1.IExecuteMultiOperationRequest = {
        namespace: this.options.namespace,
        operations: [
          {
            startWorkflow: startRequest,
          },
          {
            updateWorkflow: updateRequest,
          },
        ],
      };

      let multiOpResp: temporal.api.workflowservice.v1.IExecuteMultiOperationResponse;
      let startResp: temporal.api.workflowservice.v1.IStartWorkflowExecutionResponse;
      let updateResp: temporal.api.workflowservice.v1.IUpdateWorkflowExecutionResponse;
      let reachedStage: temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage;
      // Repeatedly send ExecuteMultiOperation until update is durable (if the server receives a request with
      // an update ID that already exists, it responds with information for the existing update). If the
      // requested wait stage is COMPLETED, further polling is done before returning the UpdateHandle.
      do {
        multiOpResp = await this.workflowService.executeMultiOperation(multiOpReq);
        startResp = multiOpResp.responses?.[0]
          ?.startWorkflow as temporal.api.workflowservice.v1.IStartWorkflowExecutionResponse;
        if (!seenStart) {
          onStart(startResp);
          seenStart = true;
        }
        updateResp = multiOpResp.responses?.[1]
          ?.updateWorkflow as temporal.api.workflowservice.v1.IUpdateWorkflowExecutionResponse;
        reachedStage =
          updateResp.stage ??
          UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_UNSPECIFIED;
      } while (reachedStage < UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED);
      return {
        workflowExecution: {
          workflowId: updateResp.updateRef!.workflowExecution!.workflowId!,
          runId: updateResp.updateRef!.workflowExecution!.runId!,
        },
        updateId: updateRequest.request!.meta!.updateId!,
        updateOutcome: updateResp.outcome ?? undefined,
      };
    } catch (thrownError) {
      let err = thrownError;
      if (isGrpcServiceError(err) && err.code === grpcStatus.ALREADY_EXISTS) {
        err = new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          input.workflowStartOptions.workflowId,
          input.workflowType
        );
      }
      if (!seenStart) {
        onStartError(err);
      }
      if (isGrpcServiceError(err)) {
        this.rethrowUpdateGrpcError(err, 'Update-With-Start failed', updateInput.workflowExecution);
      }
      throw err;
    }
  }

  protected createWorkflowUpdateHandle<Ret>(
    updateId: string,
    workflowId: string,
    workflowRunId?: string,
    outcome?: temporal.api.update.v1.IOutcome
  ): WorkflowUpdateHandle<Ret> {
    return {
      updateId,
      workflowId,
      workflowRunId,
      result: async () => {
        const completedOutcome =
          outcome ?? (await this._pollForUpdateOutcome(updateId, { workflowId, runId: workflowRunId }));
        if (completedOutcome.failure) {
          throw new WorkflowUpdateFailedError(
            'Workflow Update failed',
            await decodeOptionalFailureToOptionalError(this.dataConverter, completedOutcome.failure)
          );
        } else {
          return await decodeFromPayloadsAtIndex<Ret>(this.dataConverter, 0, completedOutcome.success?.payloads);
        }
      },
    };
  }

  /**
   * Poll Update until a response with an outcome is received; return that outcome.
   * This is used directly; no interceptor is available.
   */
  protected async _pollForUpdateOutcome(
    updateId: string,
    workflowExecution: temporal.api.common.v1.IWorkflowExecution
  ): Promise<temporal.api.update.v1.IOutcome> {
    const req: temporal.api.workflowservice.v1.IPollWorkflowExecutionUpdateRequest = {
      namespace: this.options.namespace,
      updateRef: { workflowExecution, updateId },
      identity: this.options.identity,
      waitPolicy: {
        lifecycleStage: encodeWorkflowUpdateStage(WorkflowUpdateStage.COMPLETED),
      },
    };
    for (;;) {
      try {
        const response = await this.workflowService.pollWorkflowExecutionUpdate(req);
        if (response.outcome) {
          return response.outcome;
        }
      } catch (err) {
        const wE = typeof workflowExecution.workflowId === 'string' ? workflowExecution : undefined;
        this.rethrowUpdateGrpcError(err, 'Workflow Update Poll failed', wE as WorkflowExecution);
      }
    }
  }

  /**
   * Use given input to make a signalWorkflowExecution call to the service
   *
   * Used as the final function of the signal interceptor chain
   */
  protected async _signalWorkflowHandler(input: WorkflowSignalInput): Promise<void> {
    const req: temporal.api.workflowservice.v1.ISignalWorkflowExecutionRequest = {
      identity: this.options.identity,
      namespace: this.options.namespace,
      workflowExecution: input.workflowExecution,
      requestId: uuid4(),
      // control is unused,
      signalName: input.signalName,
      header: { fields: input.headers },
      input: { payloads: await encodeToPayloads(this.dataConverter, ...input.args) },
    };
    try {
      await this.workflowService.signalWorkflowExecution(req);
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to signal Workflow', input.workflowExecution);
    }
  }

  /**
   * Use given input to make a signalWithStartWorkflowExecution call to the service
   *
   * Used as the final function of the signalWithStart interceptor chain
   */
  protected async _signalWithStartWorkflowHandler(input: WorkflowSignalWithStartInput): Promise<string> {
    const { identity } = this.options;
    const { options, workflowType, signalName, signalArgs, headers } = input;
    const req: temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest = {
      namespace: this.options.namespace,
      identity,
      requestId: uuid4(),
      workflowId: options.workflowId,
      workflowIdReusePolicy: encodeWorkflowIdReusePolicy(options.workflowIdReusePolicy),
      workflowIdConflictPolicy: encodeWorkflowIdConflictPolicy(options.workflowIdConflictPolicy),
      workflowType: { name: workflowType },
      input: { payloads: await encodeToPayloads(this.dataConverter, ...options.args) },
      signalName,
      signalInput: { payloads: await encodeToPayloads(this.dataConverter, ...signalArgs) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL,
        name: options.taskQueue,
      },
      workflowExecutionTimeout: options.workflowExecutionTimeout,
      workflowRunTimeout: options.workflowRunTimeout,
      workflowTaskTimeout: options.workflowTaskTimeout,
      workflowStartDelay: options.startDelay,
      retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
      memo: options.memo ? { fields: await encodeMapToPayloads(this.dataConverter, options.memo) } : undefined,
      searchAttributes: options.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, options.searchAttributes),
          }
        : undefined,
      cronSchedule: options.cronSchedule,
      header: { fields: headers },
    };
    try {
      return (await this.workflowService.signalWithStartWorkflowExecution(req)).runId;
    } catch (err: any) {
      if (err.code === grpcStatus.ALREADY_EXISTS) {
        throw new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          options.workflowId,
          workflowType
        );
      }
      this.rethrowGrpcError(err, 'Failed to signalWithStart Workflow', { workflowId: options.workflowId });
    }
  }

  /**
   * Use given input to make startWorkflowExecution call to the service
   *
   * Used as the final function of the start interceptor chain
   */
  protected async _startWorkflowHandler(input: WorkflowStartInput): Promise<string> {
    const req = await this.createStartWorkflowRequest(input);
    const { options: opts, workflowType } = input;
    try {
      return (await this.workflowService.startWorkflowExecution(req)).runId;
    } catch (err: any) {
      if (err.code === grpcStatus.ALREADY_EXISTS) {
        throw new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          opts.workflowId,
          workflowType
        );
      }
      this.rethrowGrpcError(err, 'Failed to start Workflow', { workflowId: opts.workflowId });
    }
  }

  protected async createStartWorkflowRequest(input: WorkflowStartInput): Promise<StartWorkflowExecutionRequest> {
    const { options: opts, workflowType, headers } = input;
    const { identity, namespace } = this.options;
    return {
      namespace,
      identity,
      requestId: uuid4(),
      workflowId: opts.workflowId,
      workflowIdReusePolicy: encodeWorkflowIdReusePolicy(opts.workflowIdReusePolicy),
      workflowIdConflictPolicy: encodeWorkflowIdConflictPolicy(opts.workflowIdConflictPolicy),
      workflowType: { name: workflowType },
      input: { payloads: await encodeToPayloads(this.dataConverter, ...opts.args) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL,
        name: opts.taskQueue,
      },
      workflowExecutionTimeout: opts.workflowExecutionTimeout,
      workflowRunTimeout: opts.workflowRunTimeout,
      workflowTaskTimeout: opts.workflowTaskTimeout,
      workflowStartDelay: opts.startDelay,
      retryPolicy: opts.retry ? compileRetryPolicy(opts.retry) : undefined,
      memo: opts.memo ? { fields: await encodeMapToPayloads(this.dataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.searchAttributes),
          }
        : undefined,
      cronSchedule: opts.cronSchedule,
      header: { fields: headers },
    };
  }

  /**
   * Use given input to make terminateWorkflowExecution call to the service
   *
   * Used as the final function of the terminate interceptor chain
   */
  protected async _terminateWorkflowHandler(
    input: WorkflowTerminateInput
  ): Promise<TerminateWorkflowExecutionResponse> {
    const req: temporal.api.workflowservice.v1.ITerminateWorkflowExecutionRequest = {
      namespace: this.options.namespace,
      identity: this.options.identity,
      ...input,
      details: {
        payloads: input.details ? await encodeToPayloads(this.dataConverter, ...input.details) : undefined,
      },
      firstExecutionRunId: input.firstExecutionRunId,
    };
    try {
      return await this.workflowService.terminateWorkflowExecution(req);
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to terminate Workflow', input.workflowExecution);
    }
  }

  /**
   * Uses given input to make requestCancelWorkflowExecution call to the service
   *
   * Used as the final function of the cancel interceptor chain
   */
  protected async _cancelWorkflowHandler(input: WorkflowCancelInput): Promise<RequestCancelWorkflowExecutionResponse> {
    try {
      return await this.workflowService.requestCancelWorkflowExecution({
        namespace: this.options.namespace,
        identity: this.options.identity,
        requestId: uuid4(),
        workflowExecution: input.workflowExecution,
        firstExecutionRunId: input.firstExecutionRunId,
      });
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to cancel workflow', input.workflowExecution);
    }
  }

  /**
   * Uses given input to make describeWorkflowExecution call to the service
   *
   * Used as the final function of the describe interceptor chain
   */
  protected async _describeWorkflowHandler(input: WorkflowDescribeInput): Promise<DescribeWorkflowExecutionResponse> {
    try {
      return await this.workflowService.describeWorkflowExecution({
        namespace: this.options.namespace,
        execution: input.workflowExecution,
      });
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to describe workflow', input.workflowExecution);
    }
  }

  /**
   * Create a new workflow handle for new or existing Workflow execution
   */
  protected _createWorkflowHandle<T extends Workflow>({
    workflowId,
    runId,
    firstExecutionRunId,
    interceptors,
    runIdForResult,
    ...resultOptions
  }: WorkflowHandleOptions): WorkflowHandle<T> {
    const _startUpdate = async <Ret, Args extends unknown[]>(
      def: UpdateDefinition<Ret, Args> | string,
      waitForStage: WorkflowUpdateStage,
      options?: WorkflowUpdateOptions & { args?: Args }
    ): Promise<WorkflowUpdateHandle<Ret>> => {
      const next = this._startUpdateHandler.bind(this, waitForStage);
      const fn = composeInterceptors(interceptors, 'startUpdate', next);
      const { args, ...opts } = options ?? {};
      const input = {
        workflowExecution: { workflowId, runId },
        firstExecutionRunId,
        updateName: typeof def === 'string' ? def : def.name,
        args: args ?? [],
        waitForStage,
        headers: {},
        options: opts,
      };
      const output = await fn(input);
      const handle = this.createWorkflowUpdateHandle<Ret>(
        output.updateId,
        input.workflowExecution.workflowId,
        output.workflowRunId,
        output.outcome
      );
      if (!output.outcome && waitForStage === WorkflowUpdateStage.COMPLETED) {
        await this._pollForUpdateOutcome(handle.updateId, input.workflowExecution);
      }
      return handle;
    };

    return {
      client: this,
      workflowId,
      async result(): Promise<WorkflowResultType<T>> {
        return this.client.result(workflowId, runIdForResult, resultOptions);
      },
      async terminate(reason?: string) {
        const next = this.client._terminateWorkflowHandler.bind(this.client);
        const fn = composeInterceptors(interceptors, 'terminate', next);
        return await fn({
          workflowExecution: { workflowId, runId },
          reason,
          firstExecutionRunId,
        });
      },
      async cancel() {
        const next = this.client._cancelWorkflowHandler.bind(this.client);
        const fn = composeInterceptors(interceptors, 'cancel', next);
        return await fn({
          workflowExecution: { workflowId, runId },
          firstExecutionRunId,
        });
      },
      async describe() {
        const next = this.client._describeWorkflowHandler.bind(this.client);
        const fn = composeInterceptors(interceptors, 'describe', next);
        const raw = await fn({
          workflowExecution: { workflowId, runId },
        });
        const info = await executionInfoFromRaw(raw.workflowExecutionInfo ?? {}, this.client.dataConverter, raw);
        return {
          ...info,
          raw,
        };
      },
      async fetchHistory() {
        let nextPageToken: Uint8Array | undefined = undefined;
        const events = Array<temporal.api.history.v1.IHistoryEvent>();
        for (;;) {
          const response: temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse =
            await this.client.workflowService.getWorkflowExecutionHistory({
              nextPageToken,
              namespace: this.client.options.namespace,
              execution: { workflowId, runId },
            });
          events.push(...(response.history?.events ?? []));
          nextPageToken = response.nextPageToken;
          if (nextPageToken == null || nextPageToken.length === 0) break;
        }
        return temporal.api.history.v1.History.create({ events });
      },
      async startUpdate<Ret, Args extends any[]>(
        def: UpdateDefinition<Ret, Args> | string,
        options: WorkflowUpdateOptions & {
          args?: Args;
          waitForStage: typeof WorkflowUpdateStage.ACCEPTED;
        }
      ): Promise<WorkflowUpdateHandle<Ret>> {
        return await _startUpdate(def, options.waitForStage, options);
      },
      async executeUpdate<Ret, Args extends any[]>(
        def: UpdateDefinition<Ret, Args> | string,
        options?: WorkflowUpdateOptions & { args?: Args }
      ): Promise<Ret> {
        const handle = await _startUpdate(def, WorkflowUpdateStage.COMPLETED, options);
        return await handle.result();
      },
      getUpdateHandle<Ret>(updateId: string): WorkflowUpdateHandle<Ret> {
        return this.client.createWorkflowUpdateHandle(updateId, workflowId, runId);
      },
      async signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void> {
        const next = this.client._signalWorkflowHandler.bind(this.client);
        const fn = composeInterceptors(interceptors, 'signal', next);
        await fn({
          workflowExecution: { workflowId, runId },
          signalName: typeof def === 'string' ? def : def.name,
          args,
          headers: {},
        });
      },
      async query<Ret, Args extends any[]>(def: QueryDefinition<Ret, Args> | string, ...args: Args): Promise<Ret> {
        const next = this.client._queryWorkflowHandler.bind(this.client);
        const fn = composeInterceptors(interceptors, 'query', next);
        return fn({
          workflowExecution: { workflowId, runId },
          queryRejectCondition: encodeQueryRejectCondition(this.client.options.queryRejectCondition),
          queryType: typeof def === 'string' ? def : def.name,
          args,
          headers: {},
        }) as Promise<Ret>;
      },
    };
  }

  /**
   * Create a handle to an existing Workflow.
   *
   * - If only `workflowId` is passed, and there are multiple Workflow Executions with that ID, the handle will refer to
   *   the most recent one.
   * - If `workflowId` and `runId` are passed, the handle will refer to the specific Workflow Execution with that Run
   *   ID.
   * - If `workflowId` and {@link GetWorkflowHandleOptions.firstExecutionRunId} are passed, the handle will refer to the
   *   most recent Workflow Execution in the *Chain* that started with `firstExecutionRunId`.
   *
   * A *Chain* is a series of Workflow Executions that share the same Workflow ID and are connected by:
   * - Being part of the same {@link https://docs.temporal.io/typescript/clients#scheduling-cron-workflows | Cron}
   * - {@link https://docs.temporal.io/typescript/workflows#continueasnew | Continue As New}
   * - {@link https://typescript.temporal.io/api/interfaces/client.workflowoptions/#retry | Retries}
   *
   * This method does not validate `workflowId`. If there is no Workflow Execution with the given `workflowId`, handle
   * methods like `handle.describe()` will throw a {@link WorkflowNotFoundError} error.
   */
  public getHandle<T extends Workflow>(
    workflowId: string,
    runId?: string,
    options?: GetWorkflowHandleOptions
  ): WorkflowHandle<T> {
    const interceptors = this.getOrMakeInterceptors(workflowId, runId);

    return this._createWorkflowHandle({
      workflowId,
      runId,
      firstExecutionRunId: options?.firstExecutionRunId,
      runIdForResult: runId ?? options?.firstExecutionRunId,
      interceptors,
      followRuns: options?.followRuns ?? true,
    });
  }

  protected async *_list(options?: ListOptions): AsyncIterable<WorkflowExecutionInfo> {
    let nextPageToken: Uint8Array = Buffer.alloc(0);
    for (;;) {
      let response: temporal.api.workflowservice.v1.ListWorkflowExecutionsResponse;
      try {
        response = await this.workflowService.listWorkflowExecutions({
          namespace: this.options.namespace,
          query: options?.query,
          nextPageToken,
          pageSize: options?.pageSize,
        });
      } catch (e) {
        this.rethrowGrpcError(e, 'Failed to list workflows', undefined);
      }
      // Not decoding memo payloads concurrently even though we could have to keep the lazy nature of this iterator.
      // Decoding is done for `memo` fields which tend to be small.
      // We might decide to change that based on user feedback.
      for (const raw of response.executions) {
        yield await executionInfoFromRaw(raw, this.dataConverter, raw);
      }
      nextPageToken = response.nextPageToken;
      if (nextPageToken == null || nextPageToken.length === 0) break;
    }
  }

  /**
   * Return a list of Workflow Executions matching the given `query`.
   *
   * Note that the list of Workflow Executions returned is approximate and eventually consistent.
   *
   * More info on the concept of "visibility" and the query syntax on the Temporal documentation site:
   * https://docs.temporal.io/visibility
   */
  public list(options?: ListOptions): AsyncWorkflowListIterable {
    return {
      [Symbol.asyncIterator]: () => this._list(options)[Symbol.asyncIterator](),
      intoHistories: (intoHistoriesOptions?: IntoHistoriesOptions) => {
        return mapAsyncIterable(
          this._list(options),
          async ({ workflowId, runId }) => ({
            workflowId,
            history: await this.getHandle(workflowId, runId).fetchHistory(),
          }),
          { concurrency: intoHistoriesOptions?.concurrency ?? 5 }
        );
      },
    };
  }

  /**
   * Return the number of Workflow Executions matching the given `query`. If no `query` is provided, then return the
   * total number of Workflow Executions for this namespace.
   *
   * Note that the number of Workflow Executions returned is approximate and eventually consistent.
   *
   * More info on the concept of "visibility" and the query syntax on the Temporal documentation site:
   * https://docs.temporal.io/visibility
   */
  public async count(query?: string): Promise<CountWorkflowExecution> {
    let response: temporal.api.workflowservice.v1.CountWorkflowExecutionsResponse;
    try {
      response = await this.workflowService.countWorkflowExecutions({
        namespace: this.options.namespace,
        query,
      });
    } catch (e) {
      this.rethrowGrpcError(e, 'Failed to count workflows');
    }

    return decodeCountWorkflowExecutionsResponse(response);
  }

  protected getOrMakeInterceptors(workflowId: string, runId?: string): WorkflowClientInterceptor[] {
    if (typeof this.options.interceptors === 'object' && 'calls' in this.options.interceptors) {
      // eslint-disable-next-line deprecation/deprecation
      const factories = (this.options.interceptors as WorkflowClientInterceptors).calls ?? [];
      return factories.map((ctor) => ctor({ workflowId, runId }));
    }
    return Array.isArray(this.options.interceptors) ? (this.options.interceptors as WorkflowClientInterceptor[]) : [];
  }
}

@SymbolBasedInstanceOfError('QueryRejectedError')
export class QueryRejectedError extends Error {
  constructor(public readonly status: temporal.api.enums.v1.WorkflowExecutionStatus) {
    super('Query rejected');
  }
}

@SymbolBasedInstanceOfError('QueryNotRegisteredError')
export class QueryNotRegisteredError extends Error {
  constructor(
    message: string,
    public readonly code: grpcStatus
  ) {
    super(message);
  }
}
