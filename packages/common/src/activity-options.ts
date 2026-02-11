import type { coresdk } from '@temporalio/proto';
import { RetryPolicy } from './retry-policy';
import { Duration } from './time';
import { VersioningIntent } from './versioning-intent';
import { makeProtoEnumConverters } from './internal-workflow';
import { Priority } from './priority';

// Note: The types defined in this file are here for legacy reasons. They should have been defined
// in the 'workflow' package, instead of 'common'. They are now reexported from the 'workflow'
// package, which is the preferred way to import them, but we unfortunately can't remove them from
// here as that would be a breaking change.

/**
 * Determines:
 * - whether cancellation requests should be propagated from the current Workflow to the Activity; and
 * - when should the Activity cancellation be reported to Workflow (i.e. at which moment should the
 *   Activity call's promise fail with an `ActivityFailure`, with `cause` set to a `CancelledFailure`).
 *
 * Note that this setting only applies to cancellation originating from cancellation being
 * externally requested on the Workflow itself, or from internal cancellation of the
 * `CancellationScope` in which the Activity call was made. Termination of a Workflow Execution
 * always results in cancellation of its outstanding Activity executions, regardless of those
 * Activities' {@link ActivityCancellationType} settings.
 *
 * @default ActivityCancellationType.WAIT_CANCELLATION_COMPLETED
 */
// MAINTENANCE: Keep this typedoc in sync with the `ActivityOptions.cancellationType` and
//              `LocalActivityOptions.cancellationType` fields later in this file.
export const ActivityCancellationType = {
  /**
   * Do not propagate cancellation requests to the Activity, and immediately report cancellation
   * to the caller.
   */
  ABANDON: 'ABANDON',

  /**
   * Propagate cancellation request from the Workflow to the Activity, yet _immediately_ report
   * cancellation to the caller, i.e. without waiting for the server to confirm the cancellation
   * request.
   *
   * Note that this cancellation type provides no guarantee, from the Workflow-side, that the
   * cancellation request will actually be delivered to the Activity; e.g. the calling Workflow
   * may exit before the delivery is completed, or the Activity may complete (either successfully
   * or uncessfully) before the cancellation is delivered, resulting in a situation where the
   * workflow thinks the activity was cancelled, but the activity actually completed successfully.
   *
   * To ensure that the Workflow is properly informed of the Activity's final state (i.e. either
   * completion or cancellation), use {@link WAIT_CANCELLATION_COMPLETED}.
   */
  TRY_CANCEL: 'TRY_CANCEL',

  /**
   * Propagate cancellation request from the Workflow to the Activity, and wait for the activity
   * to complete its execution (either successfully, uncessfully, or as cancelled).
   *
   * Note that the Activity must heartbeat to receive a cancellation notification. This can block
   * the Workflow's cancellation for a long time if the Activity doesn't heartbeat or chooses to
   * ignore the cancellation request.
   */
  WAIT_CANCELLATION_COMPLETED: 'WAIT_CANCELLATION_COMPLETED',
} as const;
export type ActivityCancellationType = (typeof ActivityCancellationType)[keyof typeof ActivityCancellationType];

export const [encodeActivityCancellationType, decodeActivityCancellationType] = makeProtoEnumConverters<
  coresdk.workflow_commands.ActivityCancellationType,
  typeof coresdk.workflow_commands.ActivityCancellationType,
  keyof typeof coresdk.workflow_commands.ActivityCancellationType,
  typeof ActivityCancellationType,
  ''
>(
  {
    [ActivityCancellationType.TRY_CANCEL]: 0,
    [ActivityCancellationType.WAIT_CANCELLATION_COMPLETED]: 1,
    [ActivityCancellationType.ABANDON]: 2,
  } as const,
  ''
);

/**
 * Options for remote activity invocation
 */
export interface ActivityOptions {
  /**
   * Identifier to use for tracking the activity in Workflow history.
   * The `activityId` can be accessed by the activity function.
   * Does not need to be unique.
   *
   * @default an incremental sequence number
   */
  activityId?: string;

  /**
   * Task queue name.
   *
   * @default current worker task queue
   */
  taskQueue?: string;

  /**
   * Heartbeat interval. Activity must heartbeat before this interval passes after a last heartbeat or activity start.
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  heartbeatTimeout?: Duration;

  /**
   * RetryPolicy that define how activity is retried in case of failure. If this is not set, then the server-defined default activity retry policy will be used. To ensure zero retries, set maximum attempts to 1.
   */
  retry?: RetryPolicy;

  /**
   * Maximum time of a single Activity execution attempt. Note that the Temporal Server doesn't detect Worker process
   * failures directly: instead, it relies on this timeout to detect that an Activity didn't complete on time. Therefore, this
   * timeout should be as short as the longest possible execution of the Activity body. Potentially long-running
   * Activities must specify {@link heartbeatTimeout} and call {@link activity.Context.heartbeat} periodically for
   * timely failure detection.
   *
   * Either this option or {@link scheduleToCloseTimeout} is required.
   *
   * @default `scheduleToCloseTimeout` or unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  startToCloseTimeout?: Duration;

  /**
   * Time that the Activity Task can stay in the Task Queue before it is picked up by a Worker. Do not specify this timeout unless using host-specific Task Queues for Activity Tasks are being used for routing.
   * `scheduleToStartTimeout` is always non-retryable. Retrying after this timeout doesn't make sense as it would just put the Activity Task back into the same Task Queue.
   *
   * @default `scheduleToCloseTimeout` or unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  scheduleToStartTimeout?: Duration;

  /**
   * Total time that a workflow is willing to wait for the Activity to complete.
   * `scheduleToCloseTimeout` limits the total time of an Activity's execution including retries (use {@link startToCloseTimeout} to limit the time of a single attempt).
   *
   * Either this option or {@link startToCloseTimeout} is required.
   *
   * @default unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  scheduleToCloseTimeout?: Duration;

  /**
   * Determines:
   * - whether cancellation requests should be propagated from the current Workflow to the Activity; and
   * - when should the Activity cancellation be reported to Workflow (i.e. at which moment should the
   *   Activity call's promise fail with an `ActivityFailure`, with `cause` set to a `CancelledFailure`).
   *
   * Note that this setting only applies to cancellation originating from cancellation being
   * externally requested on the Workflow itself, or from internal cancellation of the
   * `CancellationScope` in which the Activity call was made. Termination of a Workflow Execution
   * always results in cancellation of its outstanding Activity executions, regardless of those
   * Activities' {@link ActivityCancellationType} settings.
   *
   * @default ActivityCancellationType.WAIT_CANCELLATION_COMPLETED
   */
  // MAINTENANCE: Keep this typedoc in sync with the `ActivityCancellationType` enum
  cancellationType?: ActivityCancellationType;

  /**
   * Eager dispatch is an optimization that improves the throughput and load on the server for scheduling Activities.
   * When used, the server will hand out Activity tasks back to the Worker when it completes a Workflow task.
   * It is available from server version 1.17 behind the `system.enableActivityEagerExecution` feature flag.
   *
   * Eager dispatch will only be used if `allowEagerDispatch` is enabled (the default) and {@link taskQueue} is either
   * omitted or the same as the current Workflow.
   *
   * @default true
   */
  allowEagerDispatch?: boolean;

  /**
   * When using the Worker Versioning feature, specifies whether this Activity should run on a
   * worker with a compatible Build Id or not. See {@link VersioningIntent}.
   *
   * @default 'COMPATIBLE'
   *
   * @deprecated Worker Versioning is now deprecated. Please use the Worker Deployment API instead: https://docs.temporal.io/worker-deployments
   */
  versioningIntent?: VersioningIntent; // eslint-disable-line @typescript-eslint/no-deprecated

  /**
   * A fixed, single-line summary for this workflow execution that may appear in the UI/CLI.
   * This can be in single-line Temporal markdown format.
   *
   * @experimental User metadata is a new API and susceptible to change.
   */
  summary?: string;

  /**
   * Priority of this activity
   */
  priority?: Priority;
}

/**
 * Options for local activity invocation
 */
export interface LocalActivityOptions {
  /**
   * RetryPolicy that defines how an activity is retried in case of failure. If this is not set, then the SDK-defined default activity retry policy will be used.
   * Note that local activities are always executed at least once, even if maximum attempts is set to 1 due to Workflow task retries.
   */
  retry?: RetryPolicy;

  /**
   * Maximum time the local activity is allowed to execute after the task is dispatched. This
   * timeout is always retryable.
   *
   * Either this option or {@link scheduleToCloseTimeout} is required.
   * If set, this must be <= {@link scheduleToCloseTimeout}, otherwise, it will be clamped down.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  startToCloseTimeout?: Duration;

  /**
   * Limits time the local activity can idle internally before being executed. That can happen if
   * the worker is currently at max concurrent local activity executions. This timeout is always
   * non retryable as all a retry would achieve is to put it back into the same queue. Defaults
   * to {@link scheduleToCloseTimeout} if not specified and that is set. Must be <=
   * {@link scheduleToCloseTimeout} when set, otherwise, it will be clamped down.
   *
   * @default unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  scheduleToStartTimeout?: Duration;

  /**
   * Indicates how long the caller is willing to wait for local activity completion. Limits how
   * long retries will be attempted.
   *
   * Either this option or {@link startToCloseTimeout} is required.
   *
   * @default unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  scheduleToCloseTimeout?: Duration;

  /**
   * If the activity is retrying and backoff would exceed this value, a server side timer will be scheduled for the next attempt.
   * Otherwise, backoff will happen internally in the SDK.
   *
   * @default 1 minute
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   **/
  localRetryThreshold?: Duration;

  /**
   * Determines:
   * - whether cancellation requests should be propagated from the current Workflow to the Activity; and
   * - when should the Activity cancellation be reported to Workflow (i.e. at which moment should the
   *   Activity call's promise fail with an `ActivityFailure`, with `cause` set to a `CancelledFailure`).
   *
   * Note that this setting only applies to cancellation originating from cancellation being
   * externally requested on the Workflow itself, or from internal cancellation of the
   * `CancellationScope` in which the Activity call was made. Termination of a Workflow Execution
   * always results in cancellation of its outstanding Activity executions, regardless of those
   * Activities' {@link ActivityCancellationType} settings.
   *
   * @default ActivityCancellationType.WAIT_CANCELLATION_COMPLETED
   */
  // MAINTENANCE: Keep this typedoc in sync with the `ActivityCancellationType` enum
  cancellationType?: ActivityCancellationType;

  /**
   * A fixed, single-line summary for this workflow execution that may appear in the UI/CLI.
   * This can be in single-line Temporal markdown format.
   *
   * @experimental User metadata is a new API and susceptible to change.
   */
  summary?: string;
}
