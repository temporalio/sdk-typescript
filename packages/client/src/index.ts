/**
 * Client for communicating with the Temporal service.
 *
 * Interact with workflows using {@link WorkflowClient} or call GRPC methods directly using {@link Connection.service}.
 *
 * ### Usage
 * <!--SNIPSTART nodejs-hello-client-->
 * <!--SNIPEND-->
 * @module
 */

import os from 'os';
import * as grpc from '@grpc/grpc-js';
import { v4 as uuid4 } from 'uuid';
import ms from 'ms';
import * as iface from '@temporalio/proto';
import { Workflow, WorkflowSignalType, WorkflowQueryType } from '@temporalio/workflow/lib/interfaces';
import { msToTs, nullToUndefined } from '@temporalio/workflow/lib/time';
import { ResolvablePromise } from '@temporalio/workflow/lib/common';
import {
  arrayFromPayloads,
  DataConverter,
  defaultDataConverter,
  mapToPayloads,
} from '@temporalio/workflow/lib/converter/data-converter';
import * as errors from '@temporalio/workflow/lib/errors';

type StartWorkflowExecutionRequest = iface.temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest;
type GetWorkflowExecutionHistoryRequest = iface.temporal.api.workflowservice.v1.IGetWorkflowExecutionHistoryRequest;
export type DescribeWorkflowExecutionResponse =
  iface.temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse;
export type TerminateWorkflowExecutionResponse =
  iface.temporal.api.workflowservice.v1.ITerminateWorkflowExecutionResponse;
export type RequestCancelWorkflowExecutionResponse =
  iface.temporal.api.workflowservice.v1.IRequestCancelWorkflowExecutionResponse;

export type WorkflowService = iface.temporal.api.workflowservice.v1.WorkflowService;
export const { WorkflowService } = iface.temporal.api.workflowservice.v1;

type EnsurePromise<T> = T extends Promise<any> ? T : Promise<T>;

/// Takes a function type F and converts it to an async version if it isn't one already
type AsyncOnly<F extends (...args: any[]) => any> = (...args: Parameters<F>) => EnsurePromise<ReturnType<F>>;

// NOTE: this interface is duplicated in the native worker  declarations file `packages/worker/native/index.d.ts`

/** TLS configuration options. */
export interface TLSConfig {
  /**
   * Overrides the target name used for SSL host name checking.
   * If this attribute is not specified, the name used for SSL host name checking will be the host from {@link ServerOptions.url}.
   * This _should_ be used for testing only.
   */
  serverNameOverride?: string;
  /**
   * Root CA certificate used by the server. If not set, and the server's
   * cert is issued by someone the operating system trusts, verification will still work (ex: Cloud offering).
   */
  serverRootCACertificate?: Buffer;
  /** Sets the client certificate and key for connecting with mTLS */
  clientCertPair?: {
    /** The certificate for this client */
    crt: Buffer;
    /** The private key for this client */
    key: Buffer;
  };
}

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
 * const connection = new Connection();
 * // `counter` is a registered workflow file, typically found at
 * // `lib/workflows/counter.js` after building the typescript project
 * const workflow = connection.workflow<Counter>('counter', { taskQueue: 'tutorial' });
 * // start workflow main function with initialValue of 2 and await it's completion
 * const finalValue = await workflow.start(2);
 * ```
 */
export interface WorkflowClient<T extends Workflow> {
  /**
   * Start the workflow with arguments
   */
  start(...args: Parameters<T['main']>): EnsurePromise<ReturnType<T['main']>>;

  /**
   * A mapping of the different signals defined by workflow interface `T` to callbable functions.
   * Call to signal a running workflow.
   * @throws IllegalStateError if workflow has not been started
   * @example
   * ```ts
   * await workflow.started;
   * await workflow.signal.increment(3);
   * ```
   */
  signal: T extends Record<'signals', Record<string, WorkflowSignalType>>
    ? {
        [P in keyof T['signals']]: AsyncOnly<T['signals'][P]>;
      }
    : undefined;

  /**
   * A mapping of the different queries defined by workflow interface `T` to callbable functions.
   * Call to query a workflow after it's been started even if it has already completed.
   * @throws IllegalStateError if workflow has not been started
   * @example
   * ```ts
   * await workflow.started;
   * const value = await workflow.query.get();
   * ```
   */
  query: T extends Record<'queries', Record<string, WorkflowQueryType>>
    ? {
        [P in keyof T['queries']]: AsyncOnly<T['queries'][P]>;
      }
    : undefined;

  /**
   * Promise that resolves with current `runId` once the workflow is started
   * ```ts
   * const completionPromise = workflow.start();
   * await workflow.started;
   * await workflow.describe();
   * const result = await completionPromise;
   * ```
   */
  readonly started: PromiseLike<string>;
  /**
   * Describe the current workflow execution
   */
  describe(): Promise<DescribeWorkflowExecutionResponse>;
  /**
   * Terminate a running workflow, will throw if workflow was not started
   */
  terminate(reason?: string): Promise<TerminateWorkflowExecutionResponse>;
  /**
   * Cancel a running workflow, will throw if workflow was not started
   */
  cancel(): Promise<RequestCancelWorkflowExecutionResponse>;
  /**
   * Alias to {@link options}`.workflowId`
   */
  readonly workflowId: string;
  /**
   * The assigned run ID given by the server after starting the workflow
   */
  readonly runId?: string;
  /**
   * Readonly accessor to the supplied workflow options after applying {@link addDefaults}
   */
  readonly options: WorkflowOptionsWithDefaults;
  /**
   * Readonly accessor to the compiled workflow options (with ms strings converted to numbers)
   */
  readonly compiledOptions: CompiledWorkflowOptionsWithDefaults;
  readonly connection: Connection;
}

/**
 * GRPC + Temporal server connection options
 */
export interface ConnectionOptions {
  /**
   * Server address and port
   */
  address?: string;

  /**
   * TLS configuration.
   * Pass undefined to use a non-encrypted connection or an empty object to
   * connect with TLS without any customization.
   *
   * Either {@link credentials} or this may be specified for configuring TLS
   */
  tls?: TLSConfig;

  /**
   * Channel credentials, create using the factory methods defined {@link https://grpc.github.io/grpc/node/grpc.credentials.html | here}
   *
   * Either {@link tls} or this may be specified for configuring TLS
   */
  credentials?: grpc.ChannelCredentials;
  /**
   * Identity to report to the server
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;
  /**
   * {@link DataConverter} to use for serializing and deserializing payloads
   */
  dataConverter?: DataConverter;
  /**
   * GRPC Channel arguments
   *
   * @see options {@link https://grpc.github.io/grpc/core/group__grpc__arg__keys.html | here}
   */
  channelArgs?: Record<string, any>;
}

export type ConnectionOptionsWithDefaults = Required<Omit<ConnectionOptions, 'tls'>>;

export function defaultConnectionOpts(): ConnectionOptionsWithDefaults {
  return {
    // LOCAL_DOCKER_TARGET
    address: '127.0.0.1:7233',
    credentials: grpc.credentials.createInsecure(),
    dataConverter: defaultDataConverter,
    // ManagementFactory.getRuntimeMXBean().getName()
    identity: `${process.pid}@${os.hostname()}`,
    channelArgs: {},
  };
}

// Copied from https://github.com/temporalio/sdk-java/blob/master/temporal-sdk/src/main/java/io/temporal/client/WorkflowOptions.java
export interface BaseWorkflowOptions {
  /**
   * Workflow namespace
   *
   * @default default
   */
  namespace?: string;

  /**
   * Workflow id to use when starting. If not specified a UUID is generated. Note that it is
   * dangerous as in case of client side retries no deduplication will happen based on the
   * generated id. So prefer assigning business meaningful ids if possible.
   */
  workflowId?: string;

  /**
   * Specifies server behavior if a completed workflow with the same id exists. Note that under no
   * conditions Temporal allows two workflows with the same namespace and workflow id run
   * simultaneously.
   *   ALLOW_DUPLICATE_FAILED_ONLY is a default value. It means that workflow can start if
   *   previous run failed or was canceled or terminated.
   *   ALLOW_DUPLICATE allows new run independently of the previous run closure status.
   *   REJECT_DUPLICATE doesn't allow new run independently of the previous run closure status.
   */
  workflowIdReusePolicy?: iface.temporal.api.enums.v1.WorkflowIdReusePolicy;

  /**
   * Task queue to use for workflow tasks. It should match a task queue specified when creating a
   * `Worker` that hosts the workflow code.
   */
  taskQueue: string;

  retryPolicy?: iface.temporal.api.common.v1.IRetryPolicy;

  /**
   * Optional cron schedule for Workflow. If a cron schedule is specified, the Workflow will run
   * as a cron based on the schedule. The scheduling will be based on UTC time. The schedule for the next run only happens
   * after the current run is completed/failed/timeout. If a RetryPolicy is also supplied, and the Workflow failed
   * or timed out, the Workflow will be retried based on the retry policy. While the Workflow is retrying, it won't
   * schedule its next run. If the next schedule is due while the Workflow is running (or retrying), then it will skip that
   * schedule. Cron Workflow will not stop until it is terminated or cancelled (by returning temporal.CanceledError).
   * https://crontab.guru/ is useful for testing your cron expressions.
   */
  cronSchedule?: string;

  /**
   * Specifies additional non-indexed information in result of list workflow. The type of value
   * can be any object that are serializable by `DataConverter`.
   */
  memo?: Record<string, any>;

  /**
   * Specifies additional indexed information in result of list workflow. The type of value should
   * be a primitive (e.g. string, number, boolean), for dates use Date.toISOString();
   */
  searchAttributes?: Record<string, string | number | boolean>;

  // TODO: Support interceptors
}

export interface WorkflowDurationOptions {
  /**
   * The time after which workflow run is automatically terminated by Temporal service. Do not
   * rely on run timeout for business level timeouts. It is preferred to use in workflow timers
   * for this purpose.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  workflowRunTimeout?: string;

  /**
   *
   * The time after which workflow execution (which includes run retries and continue as new) is
   * automatically terminated by Temporal service. Do not rely on execution timeout for business
   * level timeouts. It is preferred to use in workflow timers for this purpose.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  workflowExecutionTimeout?: string;

  /**
   * Maximum execution time of a single workflow task. Default is 10 seconds.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  workflowTaskTimeout?: string;
}

export type WorkflowOptions = BaseWorkflowOptions & WorkflowDurationOptions;

export type RequiredWorkflowOptions = Required<
  Pick<BaseWorkflowOptions, 'workflowId' | 'workflowIdReusePolicy' | 'taskQueue' | 'namespace'>
>;

export type WorkflowOptionsWithDefaults = WorkflowOptions & RequiredWorkflowOptions;

export type CompiledWorkflowOptionsWithDefaults = BaseWorkflowOptions &
  RequiredWorkflowOptions & {
    workflowExecutionTimeout?: iface.google.protobuf.IDuration;
    workflowRunTimeout?: iface.google.protobuf.IDuration;
    workflowTaskTimeout?: iface.google.protobuf.IDuration;
  };

/**
 * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
 */
export function addDefaults(opts: WorkflowOptions): WorkflowOptionsWithDefaults {
  return {
    workflowId: uuid4(),
    namespace: 'default',
    workflowIdReusePolicy:
      iface.temporal.api.enums.v1.WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
    ...opts,
  };
}

export function compileWorkflowOptions({
  workflowExecutionTimeout,
  workflowRunTimeout,
  workflowTaskTimeout,
  ...rest
}: WorkflowOptionsWithDefaults): CompiledWorkflowOptionsWithDefaults {
  return {
    ...rest,
    workflowExecutionTimeout: workflowExecutionTimeout ? msToTs(ms(workflowExecutionTimeout)) : undefined,
    workflowRunTimeout: workflowRunTimeout ? msToTs(ms(workflowRunTimeout)) : undefined,
    workflowTaskTimeout: workflowTaskTimeout ? msToTs(ms(workflowTaskTimeout)) : undefined,
  };
}

/**
 * Convert {@link ConnectionOptions.tls} to {@link grpc.ChannelCredentials} and
 * add the grpc.ssl_target_name_override GRPC {@link ConnectionOptions.channelArgs}
 */
function normalizeGRPCConfig(options?: ConnectionOptions): ConnectionOptions {
  const { tls, credentials, ...rest } = options || {};
  if (tls) {
    if (credentials) {
      throw new TypeError('Both `tls` and `credentials` ConnectionOptions were provided');
    }
    return {
      ...rest,
      credentials: grpc.credentials.createSsl(
        tls.serverRootCACertificate,
        tls.clientCertPair?.key,
        tls.clientCertPair?.crt
      ),
      channelArgs: {
        ...rest.channelArgs,
        ...(tls.serverNameOverride ? { 'grpc.ssl_target_name_override': tls.serverNameOverride } : undefined),
      },
    };
  } else {
    return rest;
  }
}

/**
 * Client connection to the Temporal Service
 */
export class Connection {
  public static readonly Client = grpc.makeGenericClientConstructor({}, 'WorkflowService', {});
  public readonly options: ConnectionOptionsWithDefaults;
  public readonly client: grpc.Client;
  public readonly service: WorkflowService;

  constructor(options?: ConnectionOptions) {
    this.options = {
      ...defaultConnectionOpts(),
      ...normalizeGRPCConfig(options),
    };
    this.client = new Connection.Client(this.options.address, this.options.credentials, this.options.channelArgs);
    const rpcImpl = (method: { name: string }, requestData: any, callback: grpc.requestCallback<any>) => {
      return this.client.makeUnaryRequest(
        `/temporal.api.workflowservice.v1.WorkflowService/${method.name}`,
        (arg: any) => arg,
        (arg: any) => arg,
        requestData,
        // TODO: allow adding metadata and call options
        new grpc.Metadata(),
        {},
        callback
      );
    };
    this.service = WorkflowService.create(rpcImpl, false, false);
  }

  /**
   * Wait for successful connection to the server.
   *
   * @param waitTimeMs milliseconds to wait before giving up.
   *
   * @see https://grpc.github.io/grpc/node/grpc.Client.html#waitForReady__anchor
   */
  public async untilReady(waitTimeMs = 5000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.waitForReady(Date.now() + waitTimeMs, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public async startWorkflowExecution(
    opts: CompiledWorkflowOptionsWithDefaults,
    name: string,
    ...args: any[]
  ): Promise<string> {
    const { identity, dataConverter } = this.options;
    const req: StartWorkflowExecutionRequest = {
      namespace: opts.namespace,
      identity,
      requestId: uuid4(),
      workflowId: opts.workflowId,
      workflowIdReusePolicy: opts.workflowIdReusePolicy,
      workflowType: { name },
      input: { payloads: dataConverter.toPayloads(...args) },
      taskQueue: {
        kind: iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
        name: opts.taskQueue,
      },
      workflowExecutionTimeout: opts.workflowExecutionTimeout,
      workflowRunTimeout: opts.workflowRunTimeout,
      workflowTaskTimeout: opts.workflowTaskTimeout,
      retryPolicy: opts.retryPolicy,
      memo: opts.memo ? { fields: mapToPayloads(dataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: mapToPayloads(dataConverter, opts.searchAttributes),
          }
        : undefined,
      cronSchedule: opts.cronSchedule,
    };
    const res = await this.service.startWorkflowExecution(req);
    return res.runId;
  }

  public async untilComplete(workflowId: string, runId: string, namespace = 'default'): Promise<unknown> {
    const req: GetWorkflowExecutionHistoryRequest = {
      namespace,
      execution: { workflowId, runId },
      skipArchival: true,
      waitNewEvent: true,
      historyEventFilterType: iface.temporal.api.enums.v1.HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT,
    };
    let ev: iface.temporal.api.history.v1.IHistoryEvent;

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
      const [result] = arrayFromPayloads(
        this.options.dataConverter,
        ev.workflowExecutionCompletedEventAttributes.result?.payloads
      );
      return result;
    } else if (ev.workflowExecutionFailedEventAttributes) {
      throw new errors.WorkflowExecutionFailedError(
        ev.workflowExecutionFailedEventAttributes.failure?.message || 'Workflow failed without failure message'
      );
    } else if (ev.workflowExecutionCanceledEventAttributes) {
      throw new errors.WorkflowExecutionCancelledError(
        'Workflow execution cancelled',
        arrayFromPayloads(this.options.dataConverter, ev.workflowExecutionCanceledEventAttributes.details?.payloads)
      );
    } else if (ev.workflowExecutionTerminatedEventAttributes) {
      throw new errors.WorkflowExecutionTerminatedError(
        ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated',
        arrayFromPayloads(this.options.dataConverter, ev.workflowExecutionTerminatedEventAttributes.details?.payloads),
        nullToUndefined(ev.workflowExecutionTerminatedEventAttributes.identity)
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
      throw new errors.WorkflowExecutionContinuedAsNewError(
        'Workflow execution continued as new',
        newExecutionRunId
        // TODO: add more attributes
      );
    }
  }

  public workflow<T extends Workflow>(name: string, options: WorkflowOptions): WorkflowClient<T> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const optionsWithDefaults = addDefaults(options);
    const compiledOptions = compileWorkflowOptions(optionsWithDefaults);
    const started = new ResolvablePromise<string>();

    const workflow = {
      connection: this,
      runId: undefined,
      started,
      options: optionsWithDefaults,
      compiledOptions,
      workflowId: compiledOptions.workflowId,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      async start(...args: Parameters<T['main']>): EnsurePromise<ReturnType<T['main']>> {
        let runId: string;
        try {
          runId = await this.connection.startWorkflowExecution(compiledOptions, name, ...args);
          // runId is readonly in public interface
          (this as { runId?: string }).runId = runId;
          started.resolve(runId);
        } catch (err) {
          started.reject(err);
          throw err;
        }
        return (await this.connection.untilComplete(compiledOptions.workflowId, runId)) as any;
      },
      async terminate(reason?: string) {
        // TODO: should we help our users out and wait for runId to be returned instead of throwing?
        if (this.runId === undefined) {
          throw new errors.IllegalStateError('Cannot describe a workflow before it has been started');
        }
        return this.connection.service.terminateWorkflowExecution({
          namespace: compiledOptions.namespace,
          identity: this.connection.options.identity,
          workflowExecution: {
            runId: this.runId,
            workflowId: compiledOptions.workflowId,
          },
          reason,
        });
      },
      async cancel() {
        // TODO: should we help our users out and wait for runId to be returned instead of throwing?
        if (this.runId === undefined) {
          throw new errors.IllegalStateError('Cannot describe a workflow before it has been started');
        }
        return this.connection.service.requestCancelWorkflowExecution({
          namespace: compiledOptions.namespace,
          identity: this.connection.options.identity,
          requestId: uuid4(),
          workflowExecution: {
            runId: this.runId,
            workflowId: compiledOptions.workflowId,
          },
        });
      },
      async describe() {
        // TODO: should we help our users out and wait for runId to be returned instead of throwing?
        if (this.runId === undefined) {
          throw new errors.IllegalStateError('Cannot describe a workflow before it has been started');
        }
        return this.connection.service.describeWorkflowExecution({
          namespace: compiledOptions.namespace,
          execution: {
            runId: this.runId,
            workflowId: compiledOptions.workflowId,
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
            // TODO: Is it OK to signal without runId, should we wait for a runId here?
            return async (...args: any[]) => {
              this.service.signalWorkflowExecution({
                identity: this.options.identity,
                namespace: compiledOptions.namespace,
                workflowExecution: { runId: workflow.runId, workflowId: compiledOptions.workflowId },
                requestId: uuid4(),
                // control is unused,
                signalName,
                input: { payloads: this.options.dataConverter.toPayloads(...args) },
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
              const response = await this.service.queryWorkflow({
                // TODO: queryRejectCondition
                namespace: compiledOptions.namespace,
                execution: { runId: workflow.runId, workflowId: compiledOptions.workflowId },
                query: { queryType, queryArgs: { payloads: this.options.dataConverter.toPayloads(...args) } },
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
            };
          },
        }
      ) as any,
    };
    return workflow;
  }
}

export class QueryRejectedError extends Error {
  public readonly name: string = 'QueryRejectedError';
  constructor(public readonly status: iface.temporal.api.enums.v1.WorkflowExecutionStatus) {
    super('Query rejected');
  }
}
