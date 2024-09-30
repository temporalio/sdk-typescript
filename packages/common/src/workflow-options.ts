import type { temporal } from '@temporalio/proto';
import { SearchAttributes, Workflow } from './interfaces';
import { RetryPolicy } from './retry-policy';
import { Duration } from './time';
import { AssertType, CheckConstEnum } from './type-helpers';

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.WorkflowIdReusePolicy
/**
 * Concept: {@link https://docs.temporal.io/concepts/what-is-a-workflow-id-reuse-policy/ | Workflow Id Reuse Policy}
 *
 * Whether a Workflow can be started with a Workflow Id of a Closed Workflow.
 *
 * *Note: A Workflow can never be started with a Workflow Id of a Running Workflow.*
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
   * Terminate the current workflow if one is already running.
   */
  TERMINATE_IF_RUNNING: 'TERMINATE_IF_RUNNING',

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

const WorkflowIdReusePolicyToProtoMap = {
  [WorkflowIdReusePolicy.ALLOW_DUPLICATE]: 1,
  [WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY]: 2,
  [WorkflowIdReusePolicy.REJECT_DUPLICATE]: 3,
  [WorkflowIdReusePolicy.TERMINATE_IF_RUNNING]: 4,
} as const;

const WorkflowIdReusePolicyFromProtoMap = {
  0: undefined,
  1: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
  2: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
  3: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  4: WorkflowIdReusePolicy.TERMINATE_IF_RUNNING,
} as const;

export function encodeWorkflowIdReusePolicy(input: WorkflowIdReusePolicy): temporal.api.enums.v1.WorkflowIdReusePolicy {
  return input != null ? WorkflowIdReusePolicyToProtoMap[input] : 0;
}

export function decodeWorkflowIdReusePolicy(input: temporal.api.enums.v1.WorkflowIdReusePolicy): WorkflowIdReusePolicy {
  return input != null ? WorkflowIdReusePolicyFromProtoMap[input] : undefined;
}

AssertType<
  CheckConstEnum<
    'WORKFLOW_ID_REUSE_POLICY_',
    Exclude<keyof typeof WorkflowIdReusePolicy, 'WORKFLOW_ID_REUSE_POLICY_UNSPECIFIED'>,
    (typeof WorkflowIdReusePolicy)[Exclude<keyof typeof WorkflowIdReusePolicy, 'WORKFLOW_ID_REUSE_POLICY_UNSPECIFIED'>],
    typeof WorkflowIdReusePolicy,
    Exclude<keyof typeof temporal.api.enums.v1.WorkflowIdReusePolicy, 'WORKFLOW_ID_REUSE_POLICY_UNSPECIFIED'>,
    typeof temporal.api.enums.v1.WorkflowIdReusePolicy,
    typeof WorkflowIdReusePolicyToProtoMap
  >
>;

export interface BaseWorkflowOptions {
  /**
   * Whether a Workflow can be started with a Workflow Id of a Closed Workflow.
   *
   * *Note: A Workflow can never be started with a Workflow Id of a Running Workflow.*
   *
   * @default {@link WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE}
   */
  workflowIdReusePolicy?: WorkflowIdReusePolicy;

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
