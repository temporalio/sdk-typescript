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
  WorkflowSignalType,
  WorkflowQueryType,
  BaseWorkflowStub,
} from '@temporalio/common';
import { EnsurePromise } from '@temporalio/common/lib/type-helpers';
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
 * Transforms a workflow interface `T` into a client interface
 *
 * Given a workflow interface such as:
 * ```ts
 * export interface Counter {
 *   main(initialValue?: number): number;
 *   signals: {
 *     increment(amount?: number): void;
 *   };
 *   queries: {
 *     get(): number;
 *   };
 * }
 * ```
 *
 * Create a workflow client for running and interacting with a single workflow
 * ```ts
 * const client = new WorkflowClient();
 * // `counter` is a registered workflow file, typically found at
 * // `lib/workflows/counter.js` after building the typescript project
 * const workflow = connection.stub<Counter>('counter', { taskQueue: 'tutorial' });
 * // start workflow main function with initialValue of 2 and await its completion
 * await workflow.execute(2);
 * ```
 */
export interface WorkflowStub<T extends Workflow> extends BaseWorkflowStub<T> {
  /**
   * A mapping of the different queries defined by Workflow interface `T` to callable functions.
   * Call to query a Workflow after it's been started even if it has already completed.
   * @example
   * ```ts
   * const value = await workflow.query.get();
   * ```
   */
  query: T extends Record<'queries', Record<string, WorkflowQueryType>>
    ? {
        [P in keyof T['queries']]: (...args: Parameters<T['queries'][P]>) => Promise<ReturnType<T['queries'][P]>>;
      }
    : undefined;

  /**
   * Sends a signal to a running Workflow or starts a new one if not already running and immediately signals it.
   * Useful when you're unsure of the run state.
   */
  signalWithStart: T extends Record<'signals', Record<string, WorkflowSignalType>>
    ? <S extends keyof T['signals']>(
        signalName: S,
        signalArgs: Parameters<T['signals'][S]>,
        workflowArgs: Parameters<T['main']>
      ) => Promise<string>
    : never;

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
  };
}

/**
 * Client for starting Workflow executions and creating Workflow stubs
 */
export class WorkflowClient {
  public readonly options: WorkflowClientOptionsWithDefaults;

  constructor(public readonly service: WorkflowService = new Connection().service, options?: WorkflowClientOptions) {
    this.options = { ...defaultWorkflowClientOptions(), ...options };
  }

  /**
   * Starts a new Workflow execution
   */
  public async start<T extends Workflow>(
    opts: WorkflowOptions,
    name: string,
    ...args: Parameters<T['main']>
  ): Promise<string> {
    const compiledOptions = compileWorkflowOptions(addDefaults(opts));

    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) =>
      ctor({ workflowId: compiledOptions.workflowId })
    );

    const next = composeInterceptors(interceptors, 'start', this._startWorkflowHandler.bind(this));

    const start = (...args: Parameters<T['main']>) =>
      next({
        options: compiledOptions,
        headers: new Map(),
        args,
        name,
      });
    return start(...args);
  }

  /**
   * Starts a new Workflow execution and awaits its completion
   */
  public async execute<T extends Workflow>(
    opts: WorkflowOptions,
    name: string,
    ...args: Parameters<T['main']>
  ): // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  EnsurePromise<ReturnType<T['main']>> {
    const workflowId = opts.workflowId ?? uuid4();
    const runId = await this.start({ ...opts, workflowId }, name, ...args);
    return this.result(workflowId, runId);
  }

  /**
   * Gets the result of a Workflow execution
   */
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  public async result<T extends Workflow>(workflowId: string, runId?: string): EnsurePromise<ReturnType<T['main']>> {
    const req: GetWorkflowExecutionHistoryRequest = {
      namespace: this.options.namespace,
      execution: { workflowId, runId },
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
      break;
    }

    if (ev.workflowExecutionCompletedEventAttributes) {
      // Note that we can only return one value from our workflow function in JS.
      // Ignore any other payloads in result
      const [result] = await arrayFromPayloads(
        this.options.dataConverter,
        ev.workflowExecutionCompletedEventAttributes.result?.payloads
      );
      return result as any;
    } else if (ev.workflowExecutionFailedEventAttributes) {
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
      throw new errors.WorkflowExecutionTimedOutError(
        'Workflow execution timed out',
        ev.workflowExecutionTimedOutEventAttributes.retryState || 0
      );
    } else if (ev.workflowExecutionContinuedAsNewEventAttributes) {
      const { newExecutionRunId } = ev.workflowExecutionContinuedAsNewEventAttributes;
      if (!newExecutionRunId) {
        throw new Error('Expected service to return newExecutionRunId for WorkflowExecutionContinuedAsNewEvent');
      }
      throw new errors.WorkflowExecutionContinuedAsNewError('Workflow execution continued as new', newExecutionRunId);
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
      header: { fields: Object.fromEntries(headers.entries()) },
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
      header: { fields: Object.fromEntries(headers.entries()) },
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
   * Create a {@link WorkflowStub} for a new Workflow execution
   *
   * @param name workflow type name (the filename in the Node.js SDK)
   * @param options used to start the Workflow
   */
  public stub<T extends Workflow>(name: string, options: WorkflowOptions): WorkflowStub<T>;

  /**
   * Create a {@link WorkflowStub} for an existing Workflow execution
   */
  public stub<T extends Workflow>(workflowId: string): WorkflowStub<T>;

  /**
   * Create a {@link WorkflowStub} for an existing Workflow run
   */
  public stub<T extends Workflow>(workflowId: string, runId: string): WorkflowStub<T>;

  public stub<T extends Workflow>(
    nameOrWorkflowId: string,
    optionsOrRunId?: WorkflowOptions | string
  ): WorkflowStub<T> {
    if (typeof nameOrWorkflowId !== 'string') {
      throw new TypeError(
        `Invalid argument: ${nameOrWorkflowId}, expected a string with the Workflow filename or Workflow ID`
      );
    }
    if (optionsOrRunId === undefined) {
      const workflowId = nameOrWorkflowId;
      return this.connectToExistingWorkflow(workflowId);
    } else if (typeof optionsOrRunId === 'string') {
      const workflowId = nameOrWorkflowId;
      const runId = optionsOrRunId;
      return this.connectToExistingWorkflow(workflowId, runId);
    } else if (typeof optionsOrRunId === 'object') {
      const name = nameOrWorkflowId;
      const options = optionsOrRunId;
      return this.createNewWorkflow(name, options);
    } else {
      throw new TypeError(
        `Invalid argument: ${optionsOrRunId}, expected either runId (string) or options (WorkflowOptions)`
      );
    }
  }

  /**
   * Create a new workflow stub for new or existing Workflow execution
   */
  protected createWorkflowStub<T extends Workflow>(
    workflowId: string,
    runId: string | undefined,
    interceptors: WorkflowClientCallsInterceptor[],
    start: WorkflowStub<T>['start'],
    signalWithStart: WorkflowStub<T>['signalWithStart']
  ): WorkflowStub<T> {
    const namespace = this.options.namespace;

    const workflow = {
      client: this,
      workflowId,
      execute(...args: Parameters<T['main']>): EnsurePromise<ReturnType<T['main']>> {
        // Typescript doesn't know how to unpack EnsurePromise, cast to any
        return this.start(...args).then(() => this.result()) as any;
      },
      async start(...args: Parameters<T['main']>) {
        // Override runId in outer scope
        runId = await start(...args);
        return runId;
      },
      result() {
        return this.client.result(workflowId, runId) as EnsurePromise<ReturnType<T['main']>>;
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
      signal: new Proxy(
        {},
        {
          get: (_, signalName) => {
            if (typeof signalName !== 'string') {
              throw new TypeError('signalName can only be a string');
            }
            return async (...args: any[]) => {
              const next = this._signalWorkflowHandler.bind(this);
              const fn = interceptors.length ? composeInterceptors(interceptors, 'signal', next) : next;
              await fn({
                workflowExecution: { workflowId, runId },
                signalName,
                args,
              });
            };
          },
        }
      ) as any,
      query: new Proxy(
        {},
        {
          get: (_, queryType) => {
            if (typeof queryType !== 'string') {
              throw new TypeError('queryType can only be a string');
            }
            return async (...args: any[]) => {
              const next = this._queryWorkflowHandler.bind(this);
              const fn = interceptors.length ? composeInterceptors(interceptors, 'query', next) : next;
              return fn({
                workflowExecution: { workflowId, runId },
                queryRejectCondition: this.options.queryRejectCondition,
                queryType,
                args,
              });
            };
          },
        }
      ) as any,
      signalWithStart,
    };

    return workflow;
  }

  /**
   * Creates a Workflow stub for existing Workflow using `workflowId` and optional `runId`
   */
  protected connectToExistingWorkflow<T extends Workflow>(workflowId: string, runId?: string): WorkflowStub<T> {
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ workflowId, runId }));

    const startCallback = () => {
      throw new IllegalStateError('Workflow created with no WorkflowOptions cannot be started');
    };
    return this.createWorkflowStub(
      workflowId,
      runId,
      interceptors,
      startCallback,
      // Requires cast because workflow signals are optional which complicate the type
      startCallback as any
    );
  }

  /**
   * Creates a Workflow stub for new Workflow execution
   */
  protected createNewWorkflow<T extends Workflow>(name: string, options: WorkflowOptions): WorkflowStub<T> {
    const compiledOptions = compileWorkflowOptions(addDefaults(options));

    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) =>
      ctor({ workflowId: compiledOptions.workflowId })
    );

    const start = (...args: Parameters<T['main']>) => {
      const next = composeInterceptors(interceptors, 'start', this._startWorkflowHandler.bind(this));

      return next({
        options: compiledOptions,
        headers: new Map(),
        args,
        name,
      });
    };

    const signalWithStart = (signalName: string, signalArgs: unknown[], workflowArgs: Parameters<T['main']>) => {
      const next = composeInterceptors(
        interceptors,
        'signalWithStart',
        this._signalWithStartWorkflowHandler.bind(this)
      );

      return next({
        options: compiledOptions,
        headers: new Map(),
        workflowArgs,
        workflowName: name,
        signalName,
        signalArgs,
      });
    };

    return this.createWorkflowStub(
      compiledOptions.workflowId,
      undefined,
      interceptors,
      start,
      // Requires cast because workflow signals are optional which complicate the type
      signalWithStart as any
    );
  }
}

export class QueryRejectedError extends Error {
  public readonly name: string = 'QueryRejectedError';
  constructor(public readonly status: temporal.api.enums.v1.WorkflowExecutionStatus) {
    super('Query rejected');
  }
}
