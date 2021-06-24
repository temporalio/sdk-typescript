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
import * as iface from '@temporalio/proto';
import { composeInterceptors } from '@temporalio/workflow';
import { Workflow, WorkflowSignalType, WorkflowQueryType } from '@temporalio/workflow/lib/interfaces';
import { nullToUndefined } from '@temporalio/workflow/lib/time';
import { ResolvablePromise } from '@temporalio/workflow/lib/common';
import {
  arrayFromPayloads,
  DataConverter,
  defaultDataConverter,
  mapToPayloads,
} from '@temporalio/workflow/lib/converter/data-converter';
import * as errors from '@temporalio/workflow/lib/errors';
import {
  WorkflowOptions,
  WorkflowOptionsWithDefaults,
  CompiledWorkflowOptions,
  addDefaults,
  compileWorkflowOptions,
} from './workflow-options';
import {
  ConnectionInterceptors,
  WorkflowQueryInput,
  WorkflowSignalInput,
  WorkflowTerminateInput,
} from './interceptors';
import {
  StartWorkflowExecutionRequest,
  GetWorkflowExecutionHistoryRequest,
  DescribeWorkflowExecutionResponse,
  TerminateWorkflowExecutionResponse,
  RequestCancelWorkflowExecutionResponse,
} from './types';

export * from './types';
export * from './workflow-options';

export type WorkflowService = iface.temporal.api.workflowservice.v1.WorkflowService;
export const { WorkflowService } = iface.temporal.api.workflowservice.v1;
export { DataConverter, defaultDataConverter };
export * from './interceptors';

type EnsurePromise<T> = T extends Promise<any> ? T : Promise<T>;

/// Takes a function type F and converts it to an async version if it isn't one already
type AsyncOnly<F extends (...args: any[]) => any> = (...args: Parameters<F>) => EnsurePromise<ReturnType<F>>;

// NOTE: this interface is duplicated in the native worker  declarations file `packages/worker/native/index.d.ts` for lack of a shared library

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
   * A mapping of the different signals defined by workflow interface `T` to callable functions.
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
   * A mapping of the different queries defined by workflow interface `T` to callable functions.
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
  readonly compiledOptions: CompiledWorkflowOptions;
  readonly connection: Connection;
}

/**
 * GRPC + Temporal server connection options
 */
export interface ConnectionOptions {
  /**
   * Server hostname and optional port.
   * Port defaults to 7233 if address contains only host.
   *
   * @default localhost:7233
   */
  address?: string;

  /**
   * TLS configuration.
   * Pass a falsy value to use a non-encrypted connection or `true` or `{}` to
   * connect with TLS without any customization.
   *
   * Either {@link credentials} or this may be specified for configuring TLS
   */
  tls?: TLSConfig | boolean | null;

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

  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  interceptors?: ConnectionInterceptors;
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
    interceptors: {},
  };
}

/**
 * Normalize {@link ConnectionOptions.tls} by turning false and null to undefined and true to and empty object
 * NOTE: this function is duplicated in `packages/worker/src/worker.ts` for lack of a shared library
 */
function normalizeTlsConfig(tls?: ConnectionOptions['tls']): TLSConfig | undefined {
  return typeof tls === 'object' ? (tls === null ? undefined : tls) : tls ? {} : undefined;
}

/**
 * - Convert {@link ConnectionOptions.tls} to {@link grpc.ChannelCredentials}
 * - Add the grpc.ssl_target_name_override GRPC {@link ConnectionOptions.channelArgs | channel arg}
 * - Add default port to address if port not specified
 */
function normalizeGRPCConfig(options?: ConnectionOptions): ConnectionOptions {
  const { tls: tlsFromConfig, credentials, ...rest } = options || {};
  if (rest.address) {
    // eslint-disable-next-line prefer-const
    let [host, port] = rest.address.split(':', 2);
    port = port || '7233';
    rest.address = `${host}:${port}`;
  }
  const tls = normalizeTlsConfig(tlsFromConfig);
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

  public async startWorkflowExecution(opts: CompiledWorkflowOptions, name: string, ...args: any[]): Promise<string> {
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
      header: { fields: Object.fromEntries(opts.headers.entries()) },
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

  /**
   * Uses given input to make a queryWorkflow call to the service
   *
   * Used as the final function of the query interceptor chain
   */
  protected async _queryWorkflowHandler(input: WorkflowQueryInput): Promise<unknown> {
    const response = await this.service.queryWorkflow({
      // TODO: queryRejectCondition
      namespace: input.namespace,
      execution: input.workflowExecution,
      query: {
        queryType: input.queryType,
        queryArgs: { payloads: this.options.dataConverter.toPayloads(...input.args) },
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
      namespace: input.namespace,
      workflowExecution: input.workflowExecution,
      requestId: uuid4(),
      // control is unused,
      signalName: input.signalName,
      input: { payloads: this.options.dataConverter.toPayloads(...input.args) },
    });
  }

  /**
   * Uses given input to make terminateWorkflowExecution call to the service
   *
   * Used as the final function of the signal interceptor chain
   */
  protected async _terminateWorkflowHandler(
    namespace: string,
    input: WorkflowTerminateInput
  ): Promise<TerminateWorkflowExecutionResponse> {
    return this.service.terminateWorkflowExecution({
      namespace,
      identity: this.options.identity,
      ...input,
      details: { payloads: this.options.dataConverter.toPayloads(input.details) },
    });
  }

  public workflow<T extends Workflow>(name: string, options: WorkflowOptions): WorkflowClient<T> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const optionsWithDefaults = addDefaults(options);
    const compiledOptions = compileWorkflowOptions(optionsWithDefaults);
    const started = new ResolvablePromise<string>();

    const interceptors = (this.options.interceptors.workflowClient ?? []).map((ctor) => ctor(compiledOptions));
    const start = composeInterceptors(interceptors, 'start', async ({ args, name, headers }) => {
      let runId: string;
      try {
        runId = await this.startWorkflowExecution({ ...compiledOptions, headers }, name, ...args);
        // runId is readonly in public interface
        (workflow as { runId?: string }).runId = runId;
        started.resolve(runId);
      } catch (err) {
        started.reject(err);
        throw err;
      }
      return this.untilComplete(compiledOptions.workflowId, runId, compiledOptions.namespace);
    });
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
        return (await start({
          headers: new Map(),
          args,
          name,
        })) as any;
      },
      async terminate(reason?: string) {
        // TODO: should we help our users out and wait for runId to be returned instead of throwing?
        if (this.runId === undefined) {
          throw new errors.IllegalStateError('Cannot describe a workflow before it has been started');
        }
        const next = this.connection._terminateWorkflowHandler.bind(this.connection, this.options.namespace);
        const fn = interceptors.length ? composeInterceptors(interceptors, 'terminate', next) : next;
        return await fn({
          workflowExecution: { runId: workflow.runId, workflowId: workflow.workflowId },
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
              const next = this._signalWorkflowHandler.bind(this);
              const fn = interceptors.length ? composeInterceptors(interceptors, 'signal', next) : next;
              await fn({
                namespace: compiledOptions.namespace,
                workflowExecution: { runId: workflow.runId, workflowId: workflow.workflowId },
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
                namespace: compiledOptions.namespace,
                workflowExecution: { runId: workflow.runId, workflowId: compiledOptions.workflowId },
                queryType,
                args,
              });
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
