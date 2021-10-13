import os from 'os';
import { temporal } from '@temporalio/proto';
import { WorkflowClientInterceptors } from './interceptors';
import { v4 as uuid4 } from 'uuid';
import {
  arrayFromPayloads,
  mapToPayloads,
  DataConverter,
  defaultDataConverter,
  composeInterceptors,
  IllegalStateError,
  optionalFailureToOptionalError,
  Workflow,
  BaseWorkflowHandle,
  QueryDefinition,
  SignalDefinition,
  WorkflowResultType,
} from '@temporalio/common';
import { WorkflowOptions, addDefaults, compileWorkflowOptions } from './workflow-options';
import {
  WorkflowCancelInput,
  WorkflowClientCallsInterceptor,
  WorkflowQueryInput,
  WorkflowSignalInput,
  WorkflowSignalWithStartInput,
  WorkflowStartInput,
  WorkflowTerminateInput,
} from './interceptors';
import {
  GetWorkflowExecutionHistoryRequest,
  DescribeWorkflowExecutionResponse,
  StartWorkflowExecutionRequest,
  TerminateWorkflowExecutionResponse,
  RequestCancelWorkflowExecutionResponse,
} from './types';
import * as errors from './errors';
import { Connection, WorkflowService } from './connection';

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
 * const handle = connection.createWorkflowHandle(counterWorkflow, { taskQueue: 'tutorial' });
 * // Start the Workflow with initialValue of 2.
 * await handle.start(2);
 * await handle.signal(incrementSignal, 2);
 * await handle.query(getValueQuery); // 4
 * await handle.cancel();
 * await handle.result(); // throws WorkflowExecutionCancelledError
 * ```
 */
export interface WorkflowHandle<T extends Workflow> extends BaseWorkflowHandle<T> {
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
   * Sends a signal to a running Workflow or starts a new one if not already running and immediately signals it.
   * Useful when you're unsure of the Workflows' run state.
   *
   * @returns the runId of the Workflow
   */
  signalWithStart<Args extends any[] = []>(
    def: SignalDefinition<Args> | string,
    signalArgs: Args,
    workflowArgs: Parameters<T>
  ): Promise<string>;

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
  describe(): Promise<DescribeWorkflowExecutionResponse>;

  /**
   * Readonly accessor to the underlying WorkflowClient
   */
  readonly client: WorkflowClient;
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

  /**
   * Apply default options for starting new Workflows.
   *
   * These defaults are **shallowly** merged with options provided to methods that start Workflows
   * e.g. {@link WorkflowHandle.start}.
   */
  workflowDefaults?: Partial<WorkflowOptions>;
}

export type WorkflowClientOptionsWithDefaults = Required<WorkflowClientOptions>;

export function defaultWorkflowClientOptions(): WorkflowClientOptionsWithDefaults {
  return {
    dataConverter: defaultDataConverter,
    // The equivalent in Java is ManagementFactory.getRuntimeMXBean().getName()
    identity: `${process.pid}@${os.hostname()}`,
    interceptors: {},
    namespace: 'default',
    queryRejectCondition: temporal.api.enums.v1.QueryRejectCondition.QUERY_REJECT_CONDITION_UNSPECIFIED,
    workflowDefaults: {},
  };
}

function assertRequiredWorkflowOptions(opts: Partial<WorkflowOptions>): asserts opts is WorkflowOptions {
  if (!opts.taskQueue) {
    throw new TypeError('Missing WorkflowOptions.taskQueue');
  }
}

/**
 * Same as the protocol's {@link WorkflowExecution} but `workflowId` is required.
 *
 * NOTE: Does not accept nulls.
 */
export interface ValidWorkflowExecution {
  workflowId: string;
  runId?: string;
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
  followRuns: boolean;
}

/**
 * Client for starting Workflow executions and creating Workflow handles
 */
export class WorkflowClient {
  public readonly options: WorkflowClientOptionsWithDefaults;

  constructor(public readonly service: WorkflowService = new Connection().service, options?: WorkflowClientOptions) {
    this.options = { ...defaultWorkflowClientOptions(), ...options };
  }

  /**
   * Start a new Workflow execution. Resolves with the execution `runId`.
   */
  public async start<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    opts: Partial<WorkflowOptions>,
    ...args: Parameters<T>
  ): Promise<string> {
    const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;

    const mergedOptions = { ...this.options.workflowDefaults, ...opts };
    assertRequiredWorkflowOptions(mergedOptions);
    const compiledOptions = compileWorkflowOptions(addDefaults(mergedOptions));

    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) =>
      ctor({ workflowId: compiledOptions.workflowId })
    );

    const next = composeInterceptors(interceptors, 'start', this._startWorkflowHandler.bind(this));

    const start = (...args: Parameters<T>) =>
      next({
        options: compiledOptions,
        headers: {},
        args,
        name: workflowType,
      });
    return start(...args);
  }

  /**
   * Starts a new Workflow execution and awaits its completion
   */
  public async execute<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    opts: Partial<WorkflowOptions>,
    ...args: Parameters<T>
  ): Promise<WorkflowResultType<T>> {
    const workflowId = opts.workflowId ?? uuid4();
    const runId = await this.start(workflowTypeOrFunc, { ...opts, workflowId }, ...args);
    return this.result({ workflowId, runId });
  }

  /**
   * Gets the result of a Workflow execution.
   *
   * Follows the chain of execution in case Workflow continues as new, or has a cron schedule or retry policy.
   */
  public async result<T extends Workflow>(
    { workflowId, runId }: ValidWorkflowExecution,
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
      const res = await this.service.getWorkflowExecutionHistory(req);
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
        const [result] = await arrayFromPayloads(
          this.options.dataConverter,
          ev.workflowExecutionCompletedEventAttributes.result?.payloads
        );
        return result as any;
      } else if (ev.workflowExecutionFailedEventAttributes) {
        if (followRuns && ev.workflowExecutionFailedEventAttributes.newExecutionRunId) {
          execution.runId = ev.workflowExecutionFailedEventAttributes.newExecutionRunId;
          req.nextPageToken = undefined;
          continue;
        }
        const { failure } = ev.workflowExecutionFailedEventAttributes;
        throw new errors.WorkflowExecutionFailedError(
          'Workflow execution failed',
          await optionalFailureToOptionalError(failure, this.options.dataConverter)
        );
      } else if (ev.workflowExecutionCanceledEventAttributes) {
        throw new errors.WorkflowExecutionCancelledError(
          'Workflow execution cancelled',
          await arrayFromPayloads(
            this.options.dataConverter,
            ev.workflowExecutionCanceledEventAttributes.details?.payloads
          )
        );
      } else if (ev.workflowExecutionTerminatedEventAttributes) {
        throw new errors.WorkflowExecutionTerminatedError(
          ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated',
          await arrayFromPayloads(
            this.options.dataConverter,
            ev.workflowExecutionTerminatedEventAttributes.details?.payloads
          ),
          ev.workflowExecutionTerminatedEventAttributes.identity ?? undefined
        );
      } else if (ev.workflowExecutionTimedOutEventAttributes) {
        if (ev.workflowExecutionTimedOutEventAttributes.newExecutionRunId) {
          execution.runId = ev.workflowExecutionTimedOutEventAttributes.newExecutionRunId;
          req.nextPageToken = undefined;
          continue;
        }
        throw new errors.WorkflowExecutionTimedOutError(
          'Workflow execution timed out',
          ev.workflowExecutionTimedOutEventAttributes.retryState || 0
        );
      } else if (ev.workflowExecutionContinuedAsNewEventAttributes) {
        const { newExecutionRunId } = ev.workflowExecutionContinuedAsNewEventAttributes;
        if (!newExecutionRunId) {
          throw new TypeError('Expected service to return newExecutionRunId for WorkflowExecutionContinuedAsNewEvent');
        }
        if (!followRuns) {
          throw new errors.WorkflowExecutionContinuedAsNewError(
            'Workflow execution continued as new',
            newExecutionRunId
          );
        }
        execution.runId = newExecutionRunId;
        req.nextPageToken = undefined;
        continue;
      }
    }
  }

  /**
   * Uses given input to make a queryWorkflow call to the service
   *
   * Used as the final function of the query interceptor chain
   */
  protected async _queryWorkflowHandler(input: WorkflowQueryInput): Promise<unknown> {
    const response = await this.service.queryWorkflow({
      queryRejectCondition: input.queryRejectCondition,
      namespace: this.options.namespace,
      execution: input.workflowExecution,
      query: {
        queryType: input.queryType,
        queryArgs: { payloads: await this.options.dataConverter.toPayloads(...input.args) },
      },
    });
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
    return this.options.dataConverter.fromPayloads(0, response.queryResult?.payloads);
  }

  /**
   * Uses given input to make a signalWorkflowExecution call to the service
   *
   * Used as the final function of the signal interceptor chain
   */
  protected async _signalWorkflowHandler(input: WorkflowSignalInput): Promise<void> {
    await this.service.signalWorkflowExecution({
      identity: this.options.identity,
      namespace: this.options.namespace,
      workflowExecution: input.workflowExecution,
      requestId: uuid4(),
      // control is unused,
      signalName: input.signalName,
      input: { payloads: await this.options.dataConverter.toPayloads(...input.args) },
    });
  }

  /**
   * Uses given input to make a signalWithStartWorkflowExecution call to the service
   *
   * Used as the final function of the signalWithStart interceptor chain
   */
  protected async _signalWithStartWorkflowHandler(input: WorkflowSignalWithStartInput): Promise<string> {
    const { identity, dataConverter } = this.options;
    const { options, workflowName, workflowArgs, signalName, signalArgs, headers } = input;
    const { runId } = await this.service.signalWithStartWorkflowExecution({
      namespace: this.options.namespace,
      identity,
      requestId: uuid4(),
      workflowId: options.workflowId,
      workflowIdReusePolicy: options.workflowIdReusePolicy,
      workflowType: { name: workflowName },
      input: { payloads: await dataConverter.toPayloads(...workflowArgs) },
      signalName,
      signalInput: { payloads: await dataConverter.toPayloads(...signalArgs) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
        name: options.taskQueue,
      },
      workflowExecutionTimeout: options.workflowExecutionTimeout,
      workflowRunTimeout: options.workflowRunTimeout,
      workflowTaskTimeout: options.workflowTaskTimeout,
      retryPolicy: options.retryPolicy,
      memo: options.memo ? { fields: await mapToPayloads(dataConverter, options.memo) } : undefined,
      searchAttributes: options.searchAttributes
        ? {
            indexedFields: await mapToPayloads(dataConverter, options.searchAttributes),
          }
        : undefined,
      cronSchedule: options.cronSchedule,
      header: { fields: headers },
    });
    return runId;
  }

  /**
   * Uses given input to make startWorkflowExecution call to the service
   *
   * Used as the final function of the start interceptor chain
   */
  protected async _startWorkflowHandler(input: WorkflowStartInput): Promise<string> {
    const { options: opts, name, args, headers } = input;
    const { identity, dataConverter } = this.options;
    const req: StartWorkflowExecutionRequest = {
      namespace: this.options.namespace,
      identity,
      requestId: uuid4(),
      workflowId: opts.workflowId,
      workflowIdReusePolicy: opts.workflowIdReusePolicy,
      workflowType: { name },
      input: { payloads: await dataConverter.toPayloads(...args) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
        name: opts.taskQueue,
      },
      workflowExecutionTimeout: opts.workflowExecutionTimeout,
      workflowRunTimeout: opts.workflowRunTimeout,
      workflowTaskTimeout: opts.workflowTaskTimeout,
      retryPolicy: opts.retryPolicy,
      memo: opts.memo ? { fields: await mapToPayloads(dataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: await mapToPayloads(dataConverter, opts.searchAttributes),
          }
        : undefined,
      cronSchedule: opts.cronSchedule,
      header: { fields: headers },
    };
    const res = await this.service.startWorkflowExecution(req);
    return res.runId;
  }

  /**
   * Uses given input to make terminateWorkflowExecution call to the service
   *
   * Used as the final function of the terminate interceptor chain
   */
  protected async _terminateWorkflowHandler(
    input: WorkflowTerminateInput
  ): Promise<TerminateWorkflowExecutionResponse> {
    return await this.service.terminateWorkflowExecution({
      namespace: this.options.namespace,
      identity: this.options.identity,
      ...input,
      details: { payloads: await this.options.dataConverter.toPayloads(input.details) },
    });
  }

  /**
   * Uses given input to make requestCancelWorkflowExecution call to the service
   *
   * Used as the final function of the cancel interceptor chain
   */
  protected async _cancelWorkflowHandler(input: WorkflowCancelInput): Promise<RequestCancelWorkflowExecutionResponse> {
    return await this.service.requestCancelWorkflowExecution({
      namespace: this.options.namespace,
      identity: this.options.identity,
      requestId: uuid4(),
      workflowExecution: input.workflowExecution,
    });
  }

  /**
   * Create a {@link WorkflowHandle} for starting a new Workflow execution
   *
   * @param name workflow type name (the exported function name in the Node.js SDK)
   * @param options used to start the Workflow
   */
  public createWorkflowHandle<T extends Workflow>(name: string, options?: Partial<WorkflowOptions>): WorkflowHandle<T>;

  /**
   * Create a {@link WorkflowHandle} for starting a new Workflow execution
   *
   * @param func an exported function
   * @param options used to start the Workflow
   */
  public createWorkflowHandle<T extends Workflow>(func: T, options?: Partial<WorkflowOptions>): WorkflowHandle<T>;

  /**
   * Create a {@link WorkflowHandle} for an existing Workflow execution
   */
  public createWorkflowHandle<T extends Workflow>(execution: ValidWorkflowExecution): WorkflowHandle<T>;

  public createWorkflowHandle<T extends Workflow>(
    executionOrNameOrFunc: string | T | ValidWorkflowExecution,
    options?: Partial<WorkflowOptions>
  ): WorkflowHandle<T> {
    const workflowExecution =
      typeof executionOrNameOrFunc === 'object' && executionOrNameOrFunc.workflowId ? executionOrNameOrFunc : undefined;
    if (workflowExecution !== undefined) {
      return this.connectToExistingWorkflow(workflowExecution);
    }
    const workflowType =
      typeof executionOrNameOrFunc === 'string'
        ? executionOrNameOrFunc
        : typeof executionOrNameOrFunc === 'function'
        ? executionOrNameOrFunc.name
        : undefined;

    if (typeof workflowType !== 'string') {
      throw new TypeError(
        `Invalid argument: ${executionOrNameOrFunc}, expected one of: Workflow function, a string with the Workflow type name, or WorkflowExecution`
      );
    }
    return this.createNewWorkflow(workflowType, options);
  }

  /**
   * Create a new workflow handle for new or existing Workflow execution
   */
  protected _createWorkflowHandle<T extends Workflow>(
    workflowId: string,
    runId: string | undefined,
    interceptors: WorkflowClientCallsInterceptor[],
    start: WorkflowHandle<T>['start'],
    signalWithStart: WorkflowHandle<T>['signalWithStart'],
    resultOptions: WorkflowResultOptions
  ): WorkflowHandle<T> {
    const namespace = this.options.namespace;
    let startPromise: Promise<string> | undefined = undefined;

    return {
      client: this,
      workflowId,
      async execute(...args: Parameters<T>): Promise<WorkflowResultType<T>> {
        await this.start(...args);
        return await this.result();
      },
      async start(...args: Parameters<T>) {
        if (startPromise !== undefined) {
          throw new IllegalStateError('Workflow execution already started');
        }
        startPromise = start(...args);
        // Override runId in outer scope
        runId = await startPromise;
        return runId;
      },
      async result(): Promise<WorkflowResultType<T>> {
        return this.client.result({ workflowId, runId }, resultOptions);
      },
      async terminate(reason?: string) {
        const next = this.client._terminateWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'terminate', next) : next;
        return await fn({
          workflowExecution: { workflowId, runId },
          reason,
        });
      },
      async cancel() {
        const next = this.client._cancelWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'cancel', next) : next;
        return await fn({
          workflowExecution: { workflowId, runId },
        });
      },
      async describe() {
        return this.client.service.describeWorkflowExecution({
          namespace,
          execution: {
            runId,
            workflowId,
          },
        });
      },
      async signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void> {
        const next = this.client._signalWorkflowHandler.bind(this.client);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'signal', next) : next;
        await fn({
          workflowExecution: { workflowId, runId },
          signalName: typeof def === 'string' ? def : def.name,
          args,
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
        }) as Promise<Ret>;
      },
      signalWithStart,
    };
  }

  /**
   * Creates a Workflow handle for existing Workflow using `workflowId` and optional `runId`
   */
  protected connectToExistingWorkflow<T extends Workflow>({
    workflowId,
    runId,
  }: ValidWorkflowExecution): WorkflowHandle<T> {
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ workflowId, runId }));

    const startCallback = () => {
      throw new IllegalStateError('WorkflowHandle created with no WorkflowOptions cannot be started');
    };
    return this._createWorkflowHandle(
      workflowId,
      runId,
      interceptors,
      startCallback,
      // Requires cast because workflow signals are optional which complicate the type
      startCallback as any,
      { followRuns: this.options.workflowDefaults.followRuns ?? true }
    );
  }

  /**
   * Creates a Workflow handle for new Workflow execution
   */
  protected createNewWorkflow<T extends Workflow>(name: string, options?: Partial<WorkflowOptions>): WorkflowHandle<T> {
    const mergedOptions = { ...this.options.workflowDefaults, ...options };
    assertRequiredWorkflowOptions(mergedOptions);
    const compiledOptions = compileWorkflowOptions(addDefaults(mergedOptions));

    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) =>
      ctor({ workflowId: compiledOptions.workflowId })
    );

    const start = (...args: Parameters<T>) => {
      const next = composeInterceptors(interceptors, 'start', this._startWorkflowHandler.bind(this));

      return next({
        options: compiledOptions,
        headers: {},
        args,
        name,
      });
    };

    const signalWithStart = (def: SignalDefinition | string, signalArgs: unknown[], workflowArgs: Parameters<T>) => {
      const next = composeInterceptors(
        interceptors,
        'signalWithStart',
        this._signalWithStartWorkflowHandler.bind(this)
      );

      return next({
        options: compiledOptions,
        headers: {},
        workflowArgs,
        workflowName: name,
        signalName: typeof def === 'string' ? def : def.name,
        signalArgs,
      });
    };

    return this._createWorkflowHandle(
      compiledOptions.workflowId,
      undefined,
      interceptors,
      start,
      // Requires cast because workflow signals are optional which complicate the type
      signalWithStart as any,
      { followRuns: mergedOptions.followRuns ?? true }
    );
  }
}

export class QueryRejectedError extends Error {
  public readonly name: string = 'QueryRejectedError';
  constructor(public readonly status: temporal.api.enums.v1.WorkflowExecutionStatus) {
    super('Query rejected');
  }
}
