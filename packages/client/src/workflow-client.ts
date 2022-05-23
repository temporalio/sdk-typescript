import { status as grpcStatus } from '@grpc/grpc-js';
import {
  CancelledFailure,
  DataConverter,
  LoadedDataConverter,
  mapFromPayloads,
  mapToPayloads,
  RetryState,
  searchAttributePayloadConverter,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
} from '@temporalio/common';
import {
  decodeArrayFromPayloads,
  decodeFromPayloadsAtIndex,
  decodeMapFromPayloads,
  decodeOptionalFailureToOptionalError,
  encodeMapToPayloads,
  encodeToPayloads,
  loadDataConverter,
} from '@temporalio/internal-non-workflow-common';
import {
  BaseWorkflowHandle,
  compileRetryPolicy,
  composeInterceptors,
  optionalTsToDate,
  QueryDefinition,
  SignalDefinition,
  tsToDate,
  WithWorkflowArgs,
  Workflow,
  WorkflowNotFoundError,
  WorkflowResultType,
} from '@temporalio/internal-workflow-common';
import { temporal } from '@temporalio/proto';
import os from 'os';
import { v4 as uuid4 } from 'uuid';
import { Connection, WorkflowService } from './connection';
import {
  isServerErrorResponse,
  ServiceError,
  WorkflowContinuedAsNewError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError,
} from './errors';
import {
  WorkflowCancelInput,
  WorkflowClientCallsInterceptor,
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
} from './types';
import { compileWorkflowOptions, WorkflowOptions, WorkflowSignalWithStartOptions } from './workflow-options';

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
   * Cancel a running Workflow
   */
  cancel(): Promise<RequestCancelWorkflowExecutionResponse>;

  /**
   * Describe the current workflow execution
   */
  describe(): Promise<WorkflowExecutionDescription>;

  /**
   * Readonly accessor to the underlying WorkflowClient
   */
  readonly client: WorkflowClient;
}

/**
 * This interface is exactly the same as {@link WorkflowHandle} except it
 * includes the `originalRunId` returned after starting a new Workflow.
 */
export interface WorkflowHandleWithRunId<T extends Workflow = Workflow> extends WorkflowHandle<T> {
  /**
   * The runId of the initial run of the bound Workflow
   */
  readonly originalRunId: string;
}

export interface WorkflowClientOptions {
  /**
   * {@link DataConverter} to use for serializing and deserializing payloads
   */
  dataConverter?: DataConverter;

  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  interceptors?: WorkflowClientInterceptors;

  /**
   * Identity to report to the server
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  /**
   * Server namespace
   *
   * @default default
   */
  namespace?: string;

  /**
   * Should a query be rejected by closed and failed workflows
   *
   * @default QUERY_REJECT_CONDITION_UNSPECIFIED which means that closed and failed workflows are still queryable
   */
  queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
}

export type WorkflowClientOptionsWithDefaults = Required<WorkflowClientOptions>;
export type LoadedWorkflowClientOptions = WorkflowClientOptionsWithDefaults & {
  loadedDataConverter: LoadedDataConverter;
};

export function defaultWorkflowClientOptions(): WorkflowClientOptionsWithDefaults {
  return {
    dataConverter: {},
    // The equivalent in Java is ManagementFactory.getRuntimeMXBean().getName()
    identity: `${process.pid}@${os.hostname()}`,
    interceptors: {},
    namespace: 'default',
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
  interceptors: WorkflowClientCallsInterceptor[];
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
 * Options for starting a Workflow
 */
export type WorkflowStartOptions<T extends Workflow = Workflow> = WithWorkflowArgs<T, WorkflowOptions>;

/**
 * Client for starting Workflow executions and creating Workflow handles
 */
export class WorkflowClient {
  public readonly options: LoadedWorkflowClientOptions;

  constructor(public readonly service: WorkflowService = new Connection().service, options?: WorkflowClientOptions) {
    this.options = {
      ...defaultWorkflowClientOptions(),
      ...options,
      loadedDataConverter: loadDataConverter(options?.dataConverter),
    };
  }

  /**
   * Start a new Workflow execution.
   *
   * @returns the execution's `runId`.
   */
  protected async _start<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    options: WithWorkflowArgs<T, WorkflowOptions>,
    interceptors: WorkflowClientCallsInterceptor[]
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
    interceptors: WorkflowClientCallsInterceptor[]
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
      signalArgs,
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
  ): Promise<WorkflowHandleWithRunId<T>> {
    const { workflowId } = options;
    // Cast is needed because it's impossible to deduce the type in this situation
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ workflowId }));
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
    }) as WorkflowHandleWithRunId<T>; // Cast is safe because we know we add the originalRunId below
    (handle as any) /* readonly */.originalRunId = runId;
    return handle;
  }

  /**
   * Sends a signal to a running Workflow or starts a new one if not already running and immediately signals it.
   * Useful when you're unsure of the Workflows' run state.
   *
   * @returns a WorkflowHandle to the started Workflow
   */
  public async signalWithStart<T extends Workflow, SA extends any[] = []>(
    workflowTypeOrFunc: string | T,
    options: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SA>>
  ): Promise<WorkflowHandleWithRunId<T>> {
    const { workflowId } = options;
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ workflowId }));
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
    }) as WorkflowHandleWithRunId<T>; // Cast is safe because we know we add the originalRunId below
    (handle as any) /* readonly */.originalRunId = runId;
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
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ workflowId }));
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
        res = await this.service.getWorkflowExecutionHistory(req);
      } catch (err) {
        this.rethrowGrpcError(err, { workflowId, runId }, 'Failed to get Workflow execution history');
      }
      if (!res.history) {
        throw new Error('No history returned by service');
      }
      const { events } = res.history;
      if (!events) {
        throw new Error('No events in history returned by service');
      }
      if (events.length === 0) {
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
          this.options.loadedDataConverter,
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
          await decodeOptionalFailureToOptionalError(this.options.loadedDataConverter, failure),
          retryState ?? RetryState.RETRY_STATE_UNSPECIFIED
        );
      } else if (ev.workflowExecutionCanceledEventAttributes) {
        const failure = new CancelledFailure(
          'Workflow canceled',
          await decodeArrayFromPayloads(
            this.options.loadedDataConverter,
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
      response = await this.service.queryWorkflow({
        queryRejectCondition: input.queryRejectCondition,
        namespace: this.options.namespace,
        execution: input.workflowExecution,
        query: {
          queryType: input.queryType,
          queryArgs: { payloads: await encodeToPayloads(this.options.loadedDataConverter, ...input.args) },
          header: { fields: input.headers },
        },
      });
    } catch (err) {
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
    return await decodeFromPayloadsAtIndex(this.options.loadedDataConverter, 0, response.queryResult?.payloads);
  }

  /**
   * Uses given input to make a signalWorkflowExecution call to the service
   *
   * Used as the final function of the signal interceptor chain
   */
  protected async _signalWorkflowHandler(input: WorkflowSignalInput): Promise<void> {
    try {
      await this.service.signalWorkflowExecution({
        identity: this.options.identity,
        namespace: this.options.namespace,
        workflowExecution: input.workflowExecution,
        requestId: uuid4(),
        // control is unused,
        signalName: input.signalName,
        header: { fields: input.headers },
        input: { payloads: await encodeToPayloads(this.options.loadedDataConverter, ...input.args) },
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
      const { runId } = await this.service.signalWithStartWorkflowExecution({
        namespace: this.options.namespace,
        identity,
        requestId: uuid4(),
        workflowId: options.workflowId,
        workflowIdReusePolicy: options.workflowIdReusePolicy,
        workflowType: { name: workflowType },
        input: { payloads: await encodeToPayloads(this.options.loadedDataConverter, ...options.args) },
        signalName,
        signalInput: { payloads: await encodeToPayloads(this.options.loadedDataConverter, ...signalArgs) },
        taskQueue: {
          kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
          name: options.taskQueue,
        },
        workflowExecutionTimeout: options.workflowExecutionTimeout,
        workflowRunTimeout: options.workflowRunTimeout,
        workflowTaskTimeout: options.workflowTaskTimeout,
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        memo: options.memo
          ? { fields: await encodeMapToPayloads(this.options.loadedDataConverter, options.memo) }
          : undefined,
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
      input: { payloads: await encodeToPayloads(this.options.loadedDataConverter, ...opts.args) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
        name: opts.taskQueue,
      },
      workflowExecutionTimeout: opts.workflowExecutionTimeout,
      workflowRunTimeout: opts.workflowRunTimeout,
      workflowTaskTimeout: opts.workflowTaskTimeout,
      retryPolicy: opts.retry ? compileRetryPolicy(opts.retry) : undefined,
      memo: opts.memo ? { fields: await encodeMapToPayloads(this.options.loadedDataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.searchAttributes),
          }
        : undefined,
      cronSchedule: opts.cronSchedule,
      header: { fields: headers },
    };
    try {
      const res = await this.service.startWorkflowExecution(req);
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
      return await this.service.terminateWorkflowExecution({
        namespace: this.options.namespace,
        identity: this.options.identity,
        ...input,
        details: {
          payloads: input.details
            ? await encodeToPayloads(this.options.loadedDataConverter, ...input.details)
            : undefined,
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
      return await this.service.requestCancelWorkflowExecution({
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
      return await this.service.describeWorkflowExecution({
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
        return {
          /* eslint-disable @typescript-eslint/no-non-null-assertion */
          type: raw.workflowExecutionInfo!.type!.name!,
          workflowId: raw.workflowExecutionInfo!.execution!.workflowId!,
          runId: raw.workflowExecutionInfo!.execution!.runId!,
          taskQueue: raw.workflowExecutionInfo!.taskQueue!,
          status: raw.workflowExecutionInfo!.status!,
          historyLength: raw.workflowExecutionInfo!.historyLength!,
          startTime: tsToDate(raw.workflowExecutionInfo!.startTime!),
          executionTime: optionalTsToDate(raw.workflowExecutionInfo!.executionTime),
          closeTime: optionalTsToDate(raw.workflowExecutionInfo!.closeTime),
          memo: await decodeMapFromPayloads(
            this.client.options.loadedDataConverter,
            raw.workflowExecutionInfo!.memo?.fields
          ),
          searchAttributes: mapFromPayloads(
            searchAttributePayloadConverter,
            raw.workflowExecutionInfo!.searchAttributes?.indexedFields
          ),
          parentExecution: raw.workflowExecutionInfo!.parentExecution
            ? {
                workflowId: raw.workflowExecutionInfo!.parentExecution!.workflowId!,
                runId: raw.workflowExecutionInfo!.parentExecution!.runId!,
              }
            : undefined,
          raw,
        };
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
   * - Being part of the same [Cron](https://docs.temporal.io/typescript/clients#scheduling-cron-workflows)
   * - [Continue As New](https://docs.temporal.io/typescript/workflows#continueasnew)
   * - [Retries](https://typescript.temporal.io/api/interfaces/client.workflowoptions/#retry)
   *
   * This method does not validate `workflowId`. If there is no Workflow Execution with the given `workflowId`, handle
   * methods like `handle.describe()` will throw a {@link WorkflowNotFoundError} error.
   */
  public getHandle<T extends Workflow>(
    workflowId: string,
    runId?: string,
    options?: GetWorkflowHandleOptions
  ): WorkflowHandle<T> {
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ workflowId, runId }));

    return this._createWorkflowHandle({
      workflowId,
      runId,
      firstExecutionRunId: options?.firstExecutionRunId,
      runIdForResult: runId ?? options?.firstExecutionRunId,
      interceptors,
      followRuns: options?.followRuns ?? true,
    });
  }
}

export class QueryRejectedError extends Error {
  public readonly name: string = 'QueryRejectedError';
  constructor(public readonly status: temporal.api.enums.v1.WorkflowExecutionStatus) {
    super('Query rejected');
  }
}
