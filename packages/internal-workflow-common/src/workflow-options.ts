import type { temporal, google } from '@temporalio/proto';
import { SearchAttributes, Workflow } from './interfaces';
import { RetryPolicy } from './retry-policy';
import { msOptionalToTs } from './time';
import { checkExtends, Replace } from './type-helpers';

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.WorkflowIdReusePolicy
export enum WorkflowIdReusePolicy {
  WORKFLOW_ID_REUSE_POLICY_UNSPECIFIED = 0,
  WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE = 1,
  WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY = 2,
  WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE = 3,
}

checkExtends<temporal.api.enums.v1.WorkflowIdReusePolicy, WorkflowIdReusePolicy>();

export interface BaseWorkflowOptions {
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
   * Controls how a Workflow Execution is retried.
   *
   * By default, Workflow Executions are not retried. Do not override this behavior unless you know what you're doing.
   * [More information](https://docs.temporal.io/concepts/what-is-a-retry-policy/).
   */
  retry?: RetryPolicy;

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
   * Specifies additional non-indexed information to attach to the Workflow Execution. The values can be anything that
   * is serializable by {@link DataConverter}.
   */
  memo?: Record<string, any>;

  /**
   * Specifies additional indexed information to attach to the Workflow Execution. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom data converter is provided.
   */
  searchAttributes?: SearchAttributes;
}

export type WithWorkflowArgs<W extends Workflow, T> = T &
  (Parameters<W> extends [any, ...any[]]
    ? {
        /**
         * Arguments to pass to the Workflow
         */
        args: Parameters<W>;
      }
    : {
        /**
         * Arguments to pass to the Workflow
         */
        args?: Parameters<W>;
      });

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

export type CommonWorkflowOptions = BaseWorkflowOptions & WorkflowDurationOptions;

export type WithCompiledWorkflowOptions<T extends CommonWorkflowOptions> = Replace<
  T,
  {
    workflowExecutionTimeout?: google.protobuf.IDuration;
    workflowRunTimeout?: google.protobuf.IDuration;
    workflowTaskTimeout?: google.protobuf.IDuration;
  }
>;

export function compileWorkflowOptions<T extends CommonWorkflowOptions>(options: T): WithCompiledWorkflowOptions<T> {
  const { workflowExecutionTimeout, workflowRunTimeout, workflowTaskTimeout, ...rest } = options;

  return {
    ...rest,
    workflowExecutionTimeout: msOptionalToTs(workflowExecutionTimeout),
    workflowRunTimeout: msOptionalToTs(workflowRunTimeout),
    workflowTaskTimeout: msOptionalToTs(workflowTaskTimeout),
  };
}
