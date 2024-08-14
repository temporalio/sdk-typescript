import type { temporal } from '@temporalio/proto';
import { SearchAttributes, Workflow } from './interfaces';
import { RetryPolicy } from './retry-policy';
import { Duration } from './time';
import { checkExtends } from './type-helpers';

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.WorkflowIdReusePolicy
/**
 * Defines what happens when trying to start a Workflow with the same ID as a *Closed* Workflow.
 *
 * See {@link WorkflowOptions.workflowIdConflictPolicy} for what happens when trying to start a Workflow with the same ID as a *Running* Workflow.
 *
 * Concept: {@link https://docs.temporal.io/concepts/what-is-a-workflow-id-reuse-policy/ | Workflow Id Reuse Policy}
 *
 * *Note: It is not possible to have two actively running Workflows with the same ID.*
 *
 */
export enum WorkflowIdReusePolicy {
  /**
   * No need to use this.
   *
   * (If a `WorkflowIdReusePolicy` is set to this, or is not set at all, the default value will be used.)
   */
  WORKFLOW_ID_REUSE_POLICY_UNSPECIFIED = 0,

  /**
   * The Workflow can be started if the previous Workflow is in a Closed state.
   * @default
   */
  WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE = 1,

  /**
   * The Workflow can be started if the previous Workflow is in a Closed state that is not Completed.
   */
  WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY = 2,

  /**
   * The Workflow cannot be started.
   */
  WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE = 3,

  /**
   * Terminate the current workflow if one is already running, otherwise allow a duplicate ID.
   *
   * Deprecated: use `WORKFLOW_ID_CONFLICT_POLICY_TERMINATE_EXISTING` and `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE` instead.
   *
   * This option belongs in `WorkflowIdConflictPolicy` but it is here for backwards compatibility.
   * *Note: If setting this option, `WorkflowIdConflictPolicy` must be left unspecified.*
   */
  WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING = 4,
}

checkExtends<temporal.api.enums.v1.WorkflowIdReusePolicy, WorkflowIdReusePolicy>();
checkExtends<WorkflowIdReusePolicy, temporal.api.enums.v1.WorkflowIdReusePolicy>();

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.WorkflowIdConflictPolicy
/**
 * Defines what happens when trying to start a Workflow with the same ID as a *Running* Workflow.
 *
 * See {@link WorkflowOptions.workflowIdReusePolicy} for what happens when trying to start a Workflow with the same ID as a *Closed* Workflow.
 *
 * *Note: It is not possible to have two actively running Workflows with the same ID.*
 */
export enum WorkflowIdConflictPolicy {
  /**
   *  This is the default so that we can set the policy
   * `WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING` in `WorkflowIdReusePolicy`, which is incompatible with setting any other
   *  `WorkflowIdConflictPolicy` values.
   *
   * The actual default behavior is `WORKFLOW_ID_CONFLICT_POLICY_FAIL` for a start Workflow request, and `WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING` for a signal with start Workflow request.
   */
  WORKFLOW_ID_CONFLICT_POLICY_UNSPECIFIED = 0,

  /**
   * Do not start a new Workflow. Instead raise a `WorkflowExecutionAlreadyStartedError`.
   */
  WORKFLOW_ID_CONFLICT_POLICY_FAIL = 1,

  /**
   * Do not start a new Workflow. Instead return a Workflow Handle for the currently Running Workflow.
   */
  WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING = 2,

  /**
   * Start a new Workflow, terminating the current workflow if one is already running.
   */
  WORKFLOW_ID_CONFLICT_POLICY_TERMINATE_EXISTING = 3,
}

checkExtends<temporal.api.enums.v1.WorkflowIdConflictPolicy, WorkflowIdConflictPolicy>();
checkExtends<WorkflowIdConflictPolicy, temporal.api.enums.v1.WorkflowIdConflictPolicy>();

export interface BaseWorkflowOptions {
  /**
   * Defines what happens when trying to start a Workflow with the same ID as a *Closed* Workflow.
   *
   * *Note: It is not possible to have two actively running Workflows with the same ID.*
   *
   * @default {@link WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE}
   */
  workflowIdReusePolicy?: WorkflowIdReusePolicy;

  /**
   * Defines what happens when trying to start a Workflow with the same ID as a *Running* Workflow.
   *
   * *Note: It is not possible to have two actively running Workflows with the same ID.*
   *
   * @default {@link WorkflowIdConflictPolicy.WORKFLOW_ID_CONFLICT_POLICY_UNSPECIFIED}
   */
  workflowIdConflictPolicy?: WorkflowIdConflictPolicy;

  /**
   * Controls how a Workflow Execution is retried.
   *
   * By default, Workflow Executions are not retried. Do not override this behavior unless you know what you're doing.
   * {@link https://docs.temporal.io/concepts/what-is-a-retry-policy/ | More information}.
   */
  retry?: RetryPolicy;

  /**
   * Optional cron schedule for Workflow. If a cron schedule is specified, the Workflow will run as a cron based on the
   * schedule. The scheduling will be based on UTC time. The schedule for the next run only happens after the current
   * run is completed/failed/timeout. If a RetryPolicy is also supplied, and the Workflow failed or timed out, the
   * Workflow will be retried based on the retry policy. While the Workflow is retrying, it won't schedule its next run.
   * If the next schedule is due while the Workflow is running (or retrying), then it will skip that schedule. Cron
   * Workflow will not stop until it is terminated or cancelled (by returning temporal.CanceledError).
   * https://crontab.guru/ is useful for testing your cron expressions.
   */
  cronSchedule?: string;

  /**
   * Specifies additional non-indexed information to attach to the Workflow Execution. The values can be anything that
   * is serializable by {@link DataConverter}.
   */
  memo?: Record<string, unknown>;

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
        args: Parameters<W> | Readonly<Parameters<W>>;
      }
    : {
        /**
         * Arguments to pass to the Workflow
         */
        args?: Parameters<W> | Readonly<Parameters<W>>;
      });

export interface WorkflowDurationOptions {
  /**
   * The time after which workflow run is automatically terminated by Temporal service. Do not
   * rely on run timeout for business level timeouts. It is preferred to use in workflow timers
   * for this purpose.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  workflowRunTimeout?: Duration;

  /**
   *
   * The time after which workflow execution (which includes run retries and continue as new) is
   * automatically terminated by Temporal service. Do not rely on execution timeout for business
   * level timeouts. It is preferred to use in workflow timers for this purpose.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  workflowExecutionTimeout?: Duration;

  /**
   * Maximum execution time of a single workflow task. Default is 10 seconds.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  workflowTaskTimeout?: Duration;
}

export type CommonWorkflowOptions = BaseWorkflowOptions & WorkflowDurationOptions;

export function extractWorkflowType<T extends Workflow>(workflowTypeOrFunc: string | T): string {
  if (typeof workflowTypeOrFunc === 'string') return workflowTypeOrFunc as string;
  if (typeof workflowTypeOrFunc === 'function') {
    if (workflowTypeOrFunc?.name) return workflowTypeOrFunc.name;
    throw new TypeError('Invalid workflow type: the workflow function is anonymous');
  }
  throw new TypeError(
    `Invalid workflow type: expected either a string or a function, got '${typeof workflowTypeOrFunc}'`
  );
}
