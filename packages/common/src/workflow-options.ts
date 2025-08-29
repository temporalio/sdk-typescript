import type { temporal } from '@temporalio/proto';
import { Workflow } from './interfaces';
import { RetryPolicy } from './retry-policy';
import { Duration } from './time';
import { makeProtoEnumConverters } from './internal-workflow';
import { SearchAttributePair, SearchAttributes, TypedSearchAttributes } from './search-attributes';
import { Priority } from './priority';
import { WorkflowFunctionWithOptions } from './workflow-definition-options';

/**
 * Defines what happens when trying to start a Workflow with the same ID as a *Closed* Workflow.
 *
 * See {@link WorkflowOptions.workflowIdConflictPolicy} for what happens when trying to start a
 * Workflow with the same ID as a *Running* Workflow.
 *
 * Concept: {@link https://docs.temporal.io/concepts/what-is-a-workflow-id-reuse-policy/ | Workflow Id Reuse Policy}
 *
 * *Note: It is not possible to have two actively running Workflows with the same ID.*
 *
 */
export const WorkflowIdReusePolicy = {
  /**
   * The Workflow can be started if the previous Workflow is in a Closed state.
   * @default
   */
  ALLOW_DUPLICATE: 'ALLOW_DUPLICATE',

  /**
   * The Workflow can be started if the previous Workflow is in a Closed state that is not Completed.
   */
  ALLOW_DUPLICATE_FAILED_ONLY: 'ALLOW_DUPLICATE_FAILED_ONLY',

  /**
   * The Workflow cannot be started.
   */
  REJECT_DUPLICATE: 'REJECT_DUPLICATE',

  /**
   * Terminate the current Workflow if one is already running; otherwise allow reusing the Workflow ID.
   *
   * @deprecated Use {@link WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE} instead, and
   *             set `WorkflowOptions.workflowIdConflictPolicy` to
   *             {@link WorkflowIdConflictPolicy.WORKFLOW_ID_CONFLICT_POLICY_TERMINATE_EXISTING}.
   *             When using this option, `WorkflowOptions.workflowIdConflictPolicy` must be left unspecified.
   */
  TERMINATE_IF_RUNNING: 'TERMINATE_IF_RUNNING', // eslint-disable-line deprecation/deprecation

  /// Anything below this line has been deprecated

  /**
   * No need to use this. If a `WorkflowIdReusePolicy` is set to this, or is not set at all, the default value will be used.
   *
   * @deprecated Either leave property `undefined`, or use {@link ALLOW_DUPLICATE} instead.
   */
  WORKFLOW_ID_REUSE_POLICY_UNSPECIFIED: undefined, // eslint-disable-line deprecation/deprecation

  /** @deprecated Use {@link ALLOW_DUPLICATE} instead. */
  WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE: 'ALLOW_DUPLICATE', // eslint-disable-line deprecation/deprecation

  /** @deprecated Use {@link ALLOW_DUPLICATE_FAILED_ONLY} instead. */
  WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY: 'ALLOW_DUPLICATE_FAILED_ONLY', // eslint-disable-line deprecation/deprecation

  /** @deprecated Use {@link REJECT_DUPLICATE} instead. */
  WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE: 'REJECT_DUPLICATE', // eslint-disable-line deprecation/deprecation

  /** @deprecated Use {@link TERMINATE_IF_RUNNING} instead. */
  WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING: 'TERMINATE_IF_RUNNING', // eslint-disable-line deprecation/deprecation
} as const;
export type WorkflowIdReusePolicy = (typeof WorkflowIdReusePolicy)[keyof typeof WorkflowIdReusePolicy];

export const [encodeWorkflowIdReusePolicy, decodeWorkflowIdReusePolicy] = makeProtoEnumConverters<
  temporal.api.enums.v1.WorkflowIdReusePolicy,
  typeof temporal.api.enums.v1.WorkflowIdReusePolicy,
  keyof typeof temporal.api.enums.v1.WorkflowIdReusePolicy,
  typeof WorkflowIdReusePolicy,
  'WORKFLOW_ID_REUSE_POLICY_'
>(
  {
    [WorkflowIdReusePolicy.ALLOW_DUPLICATE]: 1,
    [WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY]: 2,
    [WorkflowIdReusePolicy.REJECT_DUPLICATE]: 3,
    [WorkflowIdReusePolicy.TERMINATE_IF_RUNNING]: 4, // eslint-disable-line deprecation/deprecation
    UNSPECIFIED: 0,
  } as const,
  'WORKFLOW_ID_REUSE_POLICY_'
);

/**
 * Defines what happens when trying to start a Workflow with the same ID as a *Running* Workflow.
 *
 * See {@link WorkflowOptions.workflowIdReusePolicy} for what happens when trying to start a Workflow
 * with the same ID as a *Closed* Workflow.
 *
 * *Note: It is never possible to have two _actively running_ Workflows with the same ID.*
 */
export type WorkflowIdConflictPolicy = (typeof WorkflowIdConflictPolicy)[keyof typeof WorkflowIdConflictPolicy];
export const WorkflowIdConflictPolicy = {
  /**
   * Do not start a new Workflow. Instead raise a `WorkflowExecutionAlreadyStartedError`.
   */
  FAIL: 'FAIL',

  /**
   * Do not start a new Workflow. Instead return a Workflow Handle for the already Running Workflow.
   */
  USE_EXISTING: 'USE_EXISTING',

  /**
   * Start a new Workflow, terminating the current workflow if one is already running.
   */
  TERMINATE_EXISTING: 'TERMINATE_EXISTING',
} as const;

export const [encodeWorkflowIdConflictPolicy, decodeWorkflowIdConflictPolicy] = makeProtoEnumConverters<
  temporal.api.enums.v1.WorkflowIdConflictPolicy,
  typeof temporal.api.enums.v1.WorkflowIdConflictPolicy,
  keyof typeof temporal.api.enums.v1.WorkflowIdConflictPolicy,
  typeof WorkflowIdConflictPolicy,
  'WORKFLOW_ID_CONFLICT_POLICY_'
>(
  {
    [WorkflowIdConflictPolicy.FAIL]: 1,
    [WorkflowIdConflictPolicy.USE_EXISTING]: 2,
    [WorkflowIdConflictPolicy.TERMINATE_EXISTING]: 3,
    UNSPECIFIED: 0,
  } as const,
  'WORKFLOW_ID_CONFLICT_POLICY_'
);

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
   *
   * @deprecated Use {@link typedSearchAttributes} instead.
   */
  searchAttributes?: SearchAttributes; // eslint-disable-line deprecation/deprecation

  /**
   * Specifies additional indexed information to attach to the Workflow Execution. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom data converter is provided.
   * Note that search attributes are not encoded, as such, do not include any sensitive information.
   *
   * If both {@link searchAttributes} and {@link typedSearchAttributes} are provided, conflicting keys will be overwritten
   * by {@link typedSearchAttributes}.
   */
  typedSearchAttributes?: SearchAttributePair[] | TypedSearchAttributes;

  /**
   * General fixed details for this workflow execution that may appear in UI/CLI.
   * This can be in Temporal markdown format and can span multiple lines.
   *
   * @experimental User metadata is a new API and susceptible to change.
   */
  staticDetails?: string;
  /**
   * A single-line fixed summary for this workflow execution that may appear in the UI/CLI.
   * This can be in single-line Temporal markdown format.
   *
   * @experimental User metadata is a new API and susceptible to change.
   */
  staticSummary?: string;

  /**
   * Priority of a workflow
   */
  priority?: Priority;
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

export function extractWorkflowType<T extends Workflow>(
  workflowTypeOrFunc: string | T | WorkflowFunctionWithOptions<any[], any>
): string {
  if (typeof workflowTypeOrFunc === 'string') return workflowTypeOrFunc as string;
  if (typeof workflowTypeOrFunc === 'function') {
    if (workflowTypeOrFunc?.name) return workflowTypeOrFunc.name;
    throw new TypeError('Invalid workflow type: the workflow function is anonymous');
  }
  throw new TypeError(
    `Invalid workflow type: expected either a string or a function, got '${typeof workflowTypeOrFunc}'`
  );
}
