import os from 'os';
import grpc from 'grpc';
import { v4 as uuid4 } from 'uuid';
import ms from 'ms';
import * as iface from '@temporalio/proto';
import {
  Workflow,
  WorkflowReturnType,
  WorkflowSignalType,
  WorkflowQueryType,
} from '@temporalio/workflow/commonjs/interfaces';
import { msToTs, nullToUndefined } from '@temporalio/workflow/commonjs/time';
import {
  arrayFromPayloads,
  DataConverter,
  defaultDataConverter,
  mapToPayloads,
} from '@temporalio/workflow/commonjs/converter/data-converter';
import * as errors from '@temporalio/workflow/commonjs/errors';

type IStartWorkflowExecutionRequest = iface.temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest;
type IGetWorkflowExecutionHistoryRequest = iface.temporal.api.workflowservice.v1.IGetWorkflowExecutionHistoryRequest;

export type WorkflowService = iface.temporal.api.workflowservice.v1.WorkflowService;
export const { WorkflowService } = iface.temporal.api.workflowservice.v1;

type EnsurePromise<F> = F extends Promise<any> ? F : Promise<F>;

/// Takes a function type F and converts it to an async version if it isn't one already
type AsyncOnly<F extends (...args: any[]) => any> = (...args: Parameters<F>) => EnsurePromise<ReturnType<F>>;

export type WorkflowClient<T extends Workflow> = {
  (...args: Parameters<T['main']>): EnsurePromise<WorkflowReturnType>;

  signal: T extends Record<'signals', Record<string, WorkflowSignalType>>
    ? {
        [P in keyof T['signals']]: AsyncOnly<T['signals'][P]>;
      }
    : undefined;

  query: T extends Record<'queries', Record<string, WorkflowQueryType>>
    ? {
        [P in keyof T['queries']]: AsyncOnly<T['queries'][P]>;
      }
    : undefined;
};

export interface ServiceOptions {
  address?: string;
  credentials?: grpc.ChannelCredentials;
}

export type ServiceOptionsWithDefaults = Required<ServiceOptions>;

export function defaultServiceOptions(): ServiceOptionsWithDefaults {
  return {
    // LOCAL_DOCKER_TARGET
    address: '127.0.0.1:7233',
    credentials: grpc.credentials.createInsecure(),
  };
}

export interface ConnectionOptions {
  namespace?: string;
  identity?: string;
  dataConverter?: DataConverter;
}

export type ConnectionOptionsWithDefaults = Required<ConnectionOptions>;

export function defaultConnectionOpts(): ConnectionOptionsWithDefaults {
  return {
    namespace: 'default',
    dataConverter: defaultDataConverter,
    // ManagementFactory.getRuntimeMXBean().getName()
    identity: `${process.pid}@${os.hostname()}`,
  };
}

// Copied from https://github.com/temporalio/sdk-java/blob/master/temporal-sdk/src/main/java/io/temporal/client/WorkflowOptions.java
export interface BaseWorkflowOptions {
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
   * @format ms formatted string
   */
  workflowRunTimeout?: string;

  /**
   *
   * The time after which workflow execution (which includes run retries and continue as new) is
   * automatically terminated by Temporal service. Do not rely on execution timeout for business
   * level timeouts. It is preferred to use in workflow timers for this purpose.
   *
   * @format ms formatted string
   */
  workflowExecutionTimeout?: string;

  /**
   * Maximum execution time of a single workflow task. Default is 10 seconds.
   *
   * @format ms formatted string
   */
  workflowTaskTimeout?: string;
}

export type WorkflowOptions = BaseWorkflowOptions & WorkflowDurationOptions;

export type RequiredWorkflowOptions = Required<
  Pick<BaseWorkflowOptions, 'workflowId' | 'workflowIdReusePolicy' | 'taskQueue'>
>;

export type WorkflowOptionsWithDefaults = WorkflowOptions & RequiredWorkflowOptions;

export type CompiledWorkflowOptionsWithDefaults = BaseWorkflowOptions &
  RequiredWorkflowOptions & {
    workflowExecutionTimeout?: iface.google.protobuf.IDuration;
    workflowRunTimeout?: iface.google.protobuf.IDuration;
    workflowTaskTimeout?: iface.google.protobuf.IDuration;
  };

export function addDefaults(opts: WorkflowOptions): WorkflowOptionsWithDefaults {
  return {
    workflowId: uuid4(),
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

export class Connection {
  public static readonly Client = grpc.makeGenericClientConstructor({}, 'WorkflowService', {});
  public readonly options: ConnectionOptionsWithDefaults;
  public readonly client: grpc.Client;
  public readonly service: WorkflowService;

  constructor(svcOpts?: ServiceOptions, connOpts?: ConnectionOptions) {
    this.options = { ...defaultConnectionOpts(), ...connOpts };
    const serviceOptions = { ...defaultServiceOptions(), ...svcOpts };
    this.client = new Connection.Client(serviceOptions.address, serviceOptions.credentials, {});
    const rpcImpl = (method: { name: string }, requestData: any, callback: grpc.requestCallback<any>) => {
      return this.client.makeUnaryRequest(
        `/temporal.api.workflowservice.v1.WorkflowService/${method.name}`,
        (arg: any) => arg,
        (arg: any) => arg,
        requestData,
        null,
        null,
        callback
      );
    };
    this.service = WorkflowService.create(rpcImpl, false, false);
  }

  public async startWorkflowExecution(
    opts: CompiledWorkflowOptionsWithDefaults,
    name: string,
    ...args: any[]
  ): Promise<string> {
    const { namespace, identity, dataConverter } = this.options;
    const req: IStartWorkflowExecutionRequest = {
      namespace,
      identity,
      requestId: uuid4(),
      workflowId: opts.workflowId,
      workflowIdReusePolicy: opts.workflowIdReusePolicy,
      workflowType: { name },
      input: dataConverter.toPayloads(...args),
      taskQueue: {
        kind: iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
        name: opts.taskQueue,
      },
      workflowExecutionTimeout: opts.workflowExecutionTimeout,
      workflowRunTimeout: opts.workflowRunTimeout,
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

  public async untilComplete(workflowId: string, runId: string): Promise<unknown> {
    const req: IGetWorkflowExecutionHistoryRequest = {
      namespace: this.options.namespace,
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
        ev.workflowExecutionCompletedEventAttributes.result
      );
      return result;
    } else if (ev.workflowExecutionFailedEventAttributes) {
      throw new errors.WorkflowExecutionFailedError(
        ev.workflowExecutionFailedEventAttributes.failure?.message || 'Workflow failed without failure message'
      );
    } else if (ev.workflowExecutionCanceledEventAttributes) {
      throw new errors.WorkflowExecutionCancelledError(
        'Workflow execution cancelled',
        arrayFromPayloads(this.options.dataConverter, ev.workflowExecutionCanceledEventAttributes.details)
      );
    } else if (ev.workflowExecutionTerminatedEventAttributes) {
      throw new errors.WorkflowExecutionTerminatedError(
        ev.workflowExecutionTerminatedEventAttributes.reason || 'Workflow execution terminated',
        arrayFromPayloads(this.options.dataConverter, ev.workflowExecutionTerminatedEventAttributes.details),
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
    const compiledOptions = compileWorkflowOptions(addDefaults(options));

    const ret = async (...args: any) => {
      const runId = await this.startWorkflowExecution(compiledOptions, name, ...args);
      return this.untilComplete(compiledOptions.workflowId, runId);
    };

    ret.signal = new Proxy(
      {},
      {
        // TODO
        get(_, p) {
          return (...args: any[]) => void console.log('signal', p, ...args);
        },
      }
    );
    ret.query = new Proxy(
      {},
      {
        // TODO
        get(_, p) {
          return (...args: any[]) => void console.log('query', p, ...args);
        },
      }
    );
    return ret as any;
  }
}
