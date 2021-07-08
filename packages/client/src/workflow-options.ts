import ms from 'ms';
import { v4 as uuid4 } from 'uuid';
import { msToTs } from '@temporalio/workflow/lib/time';
import { Headers } from '@temporalio/workflow';
import * as iface from '@temporalio/proto';

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
  Pick<BaseWorkflowOptions, 'workflowId' | 'workflowIdReusePolicy' | 'taskQueue'>
>;

export type WorkflowOptionsWithDefaults = WorkflowOptions & RequiredWorkflowOptions;

export type CompiledWorkflowOptions = BaseWorkflowOptions &
  RequiredWorkflowOptions & {
    workflowExecutionTimeout?: iface.google.protobuf.IDuration;
    workflowRunTimeout?: iface.google.protobuf.IDuration;
    workflowTaskTimeout?: iface.google.protobuf.IDuration;
    /** headers are only added to CompiledWorkflowOptions because they're supposed to be injected by interceptors */
    headers: Headers;
  };

/**
 * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
 */
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
}: WorkflowOptionsWithDefaults): CompiledWorkflowOptions {
  return {
    ...rest,
    workflowExecutionTimeout: workflowExecutionTimeout ? msToTs(ms(workflowExecutionTimeout)) : undefined,
    workflowRunTimeout: workflowRunTimeout ? msToTs(ms(workflowRunTimeout)) : undefined,
    workflowTaskTimeout: workflowTaskTimeout ? msToTs(ms(workflowTaskTimeout)) : undefined,
    headers: new Map(),
  };
}
