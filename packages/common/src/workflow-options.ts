import { coresdk, google } from '@temporalio/proto/lib/coresdk';
import { msToTs } from './time';

export type WorkflowIdReusePolicy = coresdk.common.WorkflowIdReusePolicy;
export const WorkflowIdReusePolicy = coresdk.common.WorkflowIdReusePolicy;
export type RetryPolicy = coresdk.common.IRetryPolicy;

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
  workflowIdReusePolicy?: WorkflowIdReusePolicy;

  /**
   * Task queue to use for workflow tasks. It should match a task queue specified when creating a
   * `Worker` that hosts the workflow code.
   */
  taskQueue?: string;

  retryPolicy?: coresdk.common.IRetryPolicy;

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
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  workflowRunTimeout?: string | number;

  /**
   *
   * The time after which workflow execution (which includes run retries and continue as new) is
   * automatically terminated by Temporal service. Do not rely on execution timeout for business
   * level timeouts. It is preferred to use in workflow timers for this purpose.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  workflowExecutionTimeout?: string | number;

  /**
   * Maximum execution time of a single workflow task. Default is 10 seconds.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  workflowTaskTimeout?: string | number;
}

export type WorkflowOptions = BaseWorkflowOptions & WorkflowDurationOptions;

export type RequiredWorkflowOptions = Required<
  Pick<BaseWorkflowOptions, 'workflowId' | 'workflowIdReusePolicy' | 'taskQueue'>
>;

export type WorkflowOptionsWithDefaults = WorkflowOptions & RequiredWorkflowOptions;

export type CompiledWorkflowOptions = BaseWorkflowOptions &
  RequiredWorkflowOptions & {
    workflowExecutionTimeout?: google.protobuf.IDuration;
    workflowRunTimeout?: google.protobuf.IDuration;
    workflowTaskTimeout?: google.protobuf.IDuration;
  };

export function compileWorkflowOptions({
  workflowExecutionTimeout,
  workflowRunTimeout,
  workflowTaskTimeout,
  ...rest
}: WorkflowOptionsWithDefaults): CompiledWorkflowOptions {
  return {
    ...rest,
    workflowExecutionTimeout: workflowExecutionTimeout ? msToTs(workflowExecutionTimeout) : undefined,
    workflowRunTimeout: workflowRunTimeout ? msToTs(workflowRunTimeout) : undefined,
    workflowTaskTimeout: workflowTaskTimeout ? msToTs(workflowTaskTimeout) : undefined,
  };
}
