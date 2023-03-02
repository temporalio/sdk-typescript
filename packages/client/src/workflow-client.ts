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
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  WithWorkflowArgs,
  Workflow,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowResultType,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { History } from '@temporalio/common/lib/proto-utils';
import {
  decodeArrayFromPayloads,
  decodeFromPayloadsAtIndex,
  decodeOptionalFailureToOptionalError,
  encodeMapToPayloads,
  encodeToPayloads,
  filterNullAndUndefined,
} from '@temporalio/common/lib/internal-non-workflow';
import { temporal } from '@temporalio/proto';
import { isServerErrorResponse, ServiceError, WorkflowContinuedAsNewError, WorkflowFailedError } from './errors';
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
} from './interceptors';
import {
  DescribeWorkflowExecutionResponse,
  GetWorkflowExecutionHistoryRequest,
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
} from './workflow-options';
import { executionInfoFromRaw } from './helpers';
import {
  BaseClient,
  BaseClientOptions,
  defaultBaseClientOptions,
  LoadedWithDefaults,
  WithDefaults,
} from './base-client';
import { mapAsyncIterable } from './iterators-utils';

/**
 * A client side handle to a single Workflow instance.
 * It can be used to start, signal, query, wait for completion, terminate and cancel a Workflow execution.
 *
 * Given the following Workflow definition:
 * ```ts
 * export const incrementSignal = defineSignal('increment');
 * export const getValueQuery = defineQuery<number>('getValue');
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
 * await handle.query(getValueQuery); // 4
 * await handle.cancel();
 * await handle.result(); // throws WorkflowExecutionCancelledError
 * ```
 */
export interface WorkflowHandle<T extends Workflow = Workflow> extends BaseWorkflowHandle<T> {
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
   * @default QUERY_REJECT_CONDITION_UNSPECIFIED which means that closed and failed workflows are still queryable
   */
  queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
}

export type LoadedWorkflowClientOptions = LoadedWithDefaults<WorkflowClientOptions>;

function defaultWorkflowClientOptions(): WithDefaults<WorkflowClientOptions> {
  return {
    ...defaultBaseClientOptions(),
    interceptors: [],
    queryRejectCondition: temporal.api.enums.v1.QueryRejectCondition.QUERY_REJECT_CONDITION_UNSPECIFIED,
  };
}

function assertRequiredWorkflowOptions(opts: WorkflowOptions): void {
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
  return { args: args ?? [], ...rest };
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

  /**
   * Start a new Workflow execution.
   *
   * @returns the execution's `runId`.
   */
  protected async _start<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    options: WithWorkflowArgs<T, WorkflowOptions>,
    interceptors: WorkflowClientInterceptor[]
  ): Promise<string> {
    const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
    assertRequiredWorkflowOptions(options);
    const compiledOptions = compileWorkflowOptions(ensureArgs(options));

    const start = composeInterceptors(interceptors, 'start', this._startWorkflowHandler.bind(this));

    return start({
      options: compiledOptions,
      headers: {},
      workflowType,
    });
  }

  /**
   * Sends a signal to a running Workflow or starts a new one if not already running and immediately signals it.
   * Useful when you're unsure of the Workflows' run state.
   *
   * @returns the runId of the Workflow
   */
  protected async _signalWithStart<T extends Workflow, SA extends any[]>(
    workflowTypeOrFunc: string | T,
    options: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SA>>,
    interceptors: WorkflowClientInterceptor[]
  ): Promise<string> {
    const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
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
   * @returns a WorkflowHandle to the started Workflow
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
   * Sends a Signal to a running Workflow or starts a new one if not already running and immediately Signals it.
   * Useful when you're unsure whether the Workflow has been started.
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
   * Starts a new Workflow execution and awaits its completion.
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
   * Gets the result of a Workflow execution.
   *
   * Follows the chain of execution in case Workflow continues as new, or has a cron schedule or retry policy.
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
        this.rethrowGrpcError(err, { workflowId, runId }, 'Failed to get Workflow execution history');
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
          retryState ?? RetryState.RETRY_STATE_UNSPECIFIED
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
        throw new WorkflowFailedError(
          'Workflow execution cancelled',
          failure,
          RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE
        );
      } else if (ev.workflowExecutionTerminatedEventAttributes) {
        const failure = new TerminatedFailure(
          ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated'
        );
        failure.stack = '';
        throw new WorkflowFailedError(
          ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated',
          failure,
          RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE
        );
      } else if (ev.workflowExecutionTimedOutEventAttributes) {
        if (followRuns && ev.workflowExecutionTimedOutEventAttributes.newExecutionRunId) {
          execution.runId = ev.workflowExecutionTimedOutEventAttributes.newExecutionRunId;
          req.nextPageToken = undefined;
          continue;
        }
        const failure = new TimeoutFailure(
          'Workflow execution timed out',
          undefined,
          TimeoutType.TIMEOUT_TYPE_START_TO_CLOSE
        );
        failure.stack = '';
        throw new WorkflowFailedError(
          'Workflow execution timed out',
          failure,
          ev.workflowExecutionTimedOutEventAttributes.retryState || 0
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

  protected rethrowGrpcError(err: unknown, workflowExecution: WorkflowExecution, fallbackMessage: string): never {
    if (isServerErrorResponse(err)) {
      if (err.code === grpcStatus.NOT_FOUND) {
        throw new WorkflowNotFoundError(
          err.details ?? 'Workflow not found',
          workflowExecution.workflowId,
          workflowExecution.runId
        );
      }
      throw new ServiceError(fallbackMessage, { cause: err });
    }
    throw new ServiceError('Unexpected error while making gRPC request');
  }

  /**
   * Uses given input to make a queryWorkflow call to the service
   *
   * Used as the final function of the query interceptor chain
   */
  protected async _queryWorkflowHandler(input: WorkflowQueryInput): Promise<unknown> {
    let response: temporal.api.workflowservice.v1.QueryWorkflowResponse;
    try {
      response = await this.workflowService.queryWorkflow({
        queryRejectCondition: input.queryRejectCondition,
        namespace: this.options.namespace,
        execution: input.workflowExecution,
        query: {
          queryType: input.queryType,
          queryArgs: { payloads: await encodeToPayloads(this.dataConverter, ...input.args) },
          header: { fields: input.headers },
        },
      });
    } catch (err) {
      if (isServerErrorResponse(err) && err.code === grpcStatus.INVALID_ARGUMENT) {
        throw new QueryNotRegisteredError(err.message.replace(/^3 INVALID_ARGUMENT: /, ''), err.code);
      }
      this.rethrowGrpcError(err, input.workflowExecution, 'Failed to query Workflow');
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

  /**
   * Uses given input to make a signalWorkflowExecution call to the service
   *
   * Used as the final function of the signal interceptor chain
   */
  protected async _signalWorkflowHandler(input: WorkflowSignalInput): Promise<void> {
    try {
      await this.workflowService.signalWorkflowExecution({
        identity: this.options.identity,
        namespace: this.options.namespace,
        workflowExecution: input.workflowExecution,
        requestId: uuid4(),
        // control is unused,
        signalName: input.signalName,
        header: { fields: input.headers },
        input: { payloads: await encodeToPayloads(this.dataConverter, ...input.args) },
      });
    } catch (err) {
      this.rethrowGrpcError(err, input.workflowExecution, 'Failed to signal Workflow');
    }
  }

  /**
   * Uses given input to make a signalWithStartWorkflowExecution call to the service
   *
   * Used as the final function of the signalWithStart interceptor chain
   */
  protected async _signalWithStartWorkflowHandler(input: WorkflowSignalWithStartInput): Promise<string> {
    const { identity } = this.options;
    const { options, workflowType, signalName, signalArgs, headers } = input;
    try {
      const { runId } = await this.workflowService.signalWithStartWorkflowExecution({
        namespace: this.options.namespace,
        identity,
        requestId: uuid4(),
        workflowId: options.workflowId,
        workflowIdReusePolicy: options.workflowIdReusePolicy,
        workflowType: { name: workflowType },
        input: { payloads: await encodeToPayloads(this.dataConverter, ...options.args) },
        signalName,
        signalInput: { payloads: await encodeToPayloads(this.dataConverter, ...signalArgs) },
        taskQueue: {
          kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
          name: options.taskQueue,
        },
        workflowExecutionTimeout: options.workflowExecutionTimeout,
        workflowRunTimeout: options.workflowRunTimeout,
        workflowTaskTimeout: options.workflowTaskTimeout,
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        memo: options.memo ? { fields: await encodeMapToPayloads(this.dataConverter, options.memo) } : undefined,
        searchAttributes: options.searchAttributes
          ? {
              indexedFields: mapToPayloads(searchAttributePayloadConverter, options.searchAttributes),
            }
          : undefined,
        cronSchedule: options.cronSchedule,
        header: { fields: headers },
      });
      return runId;
    } catch (err) {
      this.rethrowGrpcError(err, { workflowId: options.workflowId }, 'Failed to signalWithStart Workflow');
    }
  }

  /**
   * Uses given input to make startWorkflowExecution call to the service
   *
   * Used as the final function of the start interceptor chain
   */
  protected async _startWorkflowHandler(input: WorkflowStartInput): Promise<string> {
    const { options: opts, workflowType, headers } = input;
    const { identity } = this.options;
    const req: StartWorkflowExecutionRequest = {
      namespace: this.options.namespace,
      identity,
      requestId: uuid4(),
      workflowId: opts.workflowId,
      workflowIdReusePolicy: opts.workflowIdReusePolicy,
      workflowType: { name: workflowType },
      input: { payloads: await encodeToPayloads(this.dataConverter, ...opts.args) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
        name: opts.taskQueue,
      },
      workflowExecutionTimeout: opts.workflowExecutionTimeout,
      workflowRunTimeout: opts.workflowRunTimeout,
      workflowTaskTimeout: opts.workflowTaskTimeout,
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
    try {
      const res = await this.workflowService.startWorkflowExecution(req);
      return res.runId;
    } catch (err: any) {
      if (err.code === grpcStatus.ALREADY_EXISTS) {
        throw new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          opts.workflowId,
          workflowType
        );
      }
      this.rethrowGrpcError(err, { workflowId: opts.workflowId }, 'Failed to start Workflow');
    }
  }

  /**
   * Uses given input to make terminateWorkflowExecution call to the service
   *
   * Used as the final function of the terminate interceptor chain
   */
  protected async _terminateWorkflowHandler(
    input: WorkflowTerminateInput
  ): Promise<TerminateWorkflowExecutionResponse> {
    try {
      return await this.workflowService.terminateWorkflowExecution({
        namespace: this.options.namespace,
        identity: this.options.identity,
        ...input,
        details: {
          payloads: input.details ? await encodeToPayloads(this.dataConverter, ...input.details) : undefined,
        },
        firstExecutionRunId: input.firstExecutionRunId,
      });
    } catch (err) {
      this.rethrowGrpcError(err, input.workflowExecution, 'Failed to terminate Workflow');
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
      this.rethrowGrpcError(err, input.workflowExecution, 'Failed to cancel workflow');
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
      this.rethrowGrpcError(err, input.workflowExecution, 'Failed to describe workflow');
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
    return {
      client: this,
      workflowId,
      async result(): Promise<WorkflowResultType<T>> {
        return this.client.result(workflowId, runIdForResult, resultOptions);
      },
      async terminate(reason?: string) {
        const next = this.client._terminateWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'terminate', next) : next;
        return await fn({
          workflowExecution: { workflowId, runId },
          reason,
          firstExecutionRunId,
        });
      },
      async cancel() {
        const next = this.client._cancelWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'cancel', next) : next;
        return await fn({
          workflowExecution: { workflowId, runId },
          firstExecutionRunId,
        });
      },
      async describe() {
        const next = this.client._describeWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'describe', next) : next;
        const raw = await fn({
          workflowExecution: { workflowId, runId },
        });
        const info = await executionInfoFromRaw(raw.workflowExecutionInfo ?? {}, this.client.dataConverter);
        (info as unknown as WorkflowExecutionDescription).raw = raw;
        return info;
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
      async signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void> {
        const next = this.client._signalWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'signal', next) : next;
        await fn({
          workflowExecution: { workflowId, runId },
          signalName: typeof def === 'string' ? def : def.name,
          args,
          headers: {},
        });
      },
      async query<Ret, Args extends any[]>(def: QueryDefinition<Ret, Args> | string, ...args: Args): Promise<Ret> {
        const next = this.client._queryWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'query', next) : next;
        return fn({
          workflowExecution: { workflowId, runId },
          queryRejectCondition: this.client.options.queryRejectCondition,
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
      const response = await this.workflowService.listWorkflowExecutions({
        namespace: this.options.namespace,
        query: options?.query,
        nextPageToken,
        pageSize: options?.pageSize,
      });
      // Not decoding memo payloads concurrently even though we could have to keep the lazy nature of this iterator.
      // Decoding is done for `memo` fields which tend to be small.
      // We might decide to change that based on user feedback.
      for (const raw of response.executions) {
        yield await executionInfoFromRaw(raw, this.dataConverter);
      }
      nextPageToken = response.nextPageToken;
      if (nextPageToken == null || nextPageToken.length === 0) break;
    }
  }

  /**
   * List workflows by given `query`.
   *
   * ⚠️ To use advanced query functionality, as of the 1.18 server release, you must use Elasticsearch based visibility.
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
            history: await this.getHandle(workflowId, runId)
              .fetchHistory()
              .catch((_) => undefined),
          }),
          { concurrency: intoHistoriesOptions?.concurrency ?? 5 }
        );
      },
    };
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

export class QueryRejectedError extends Error {
  public readonly name: string = 'QueryRejectedError';
  constructor(public readonly status: temporal.api.enums.v1.WorkflowExecutionStatus) {
    super('Query rejected');
  }
}

export class QueryNotRegisteredError extends Error {
  public readonly name: string = 'QueryNotRegisteredError';
  constructor(message: string, public readonly code: grpcStatus) {
    super(message);
  }
}
