import type { coresdk } from '@temporalio/proto';
import { RetryPolicy } from './retry-policy';
import { checkExtends } from './type-helpers';
import { Duration } from './time';
import { VersioningIntent } from './versioning-intent';

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from coresdk.workflow_commands.ActivityCancellationType
export enum ActivityCancellationType {
  TRY_CANCEL = 0,
  WAIT_CANCELLATION_COMPLETED = 1,
  ABANDON = 2,
}

checkExtends<coresdk.workflow_commands.ActivityCancellationType, ActivityCancellationType>();
checkExtends<ActivityCancellationType, coresdk.workflow_commands.ActivityCancellationType>();

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
   * failures directly. It relies on this timeout to detect that an Activity that didn't complete on time. So this
   * timeout should be as short as the longest possible execution of the Activity body. Potentially long running
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
   * Time that the Activity Task can stay in the Task Queue before it is picked up by a Worker. Do not specify this timeout unless using host specific Task Queues for Activity Tasks are being used for routing.
   * `scheduleToStartTimeout` is always non-retryable. Retrying after this timeout doesn't make sense as it would just put the Activity Task back into the same Task Queue.
   *
   * @default `scheduleToCloseTimeout` or unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  scheduleToStartTimeout?: Duration;

  /**
   * Total time that a workflow is willing to wait for Activity to complete.
   * `scheduleToCloseTimeout` limits the total time of an Activity's execution including retries (use {@link startToCloseTimeout} to limit the time of a single attempt).
   *
   * Either this option or {@link startToCloseTimeout} is required.
   *
   * @default unlimited
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  scheduleToCloseTimeout?: Duration;

  /**
   * Determines what the SDK does when the Activity is cancelled.
   * - `TRY_CANCEL` - Initiate a cancellation request and immediately report cancellation to the workflow.
   * - `WAIT_CANCELLATION_COMPLETED` - Wait for activity cancellation completion. Note that activity must heartbeat to receive a
   *   cancellation notification. This can block the cancellation for a long time if activity doesn't
   *   heartbeat or chooses to ignore the cancellation request.
   * - `ABANDON` - Do not request cancellation of the activity and immediately report cancellation to the workflow.
   */
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
   * @experimental
   */
  versioningIntent?: VersioningIntent;
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
   * Determines what the SDK does when the Activity is cancelled.
   * - `TRY_CANCEL` - Initiate a cancellation request and immediately report cancellation to the workflow.
   * - `WAIT_CANCELLATION_COMPLETED` - Wait for activity cancellation completion. Note that activity must heartbeat to receive a
   *   cancellation notification. This can block the cancellation for a long time if activity doesn't
   *   heartbeat or chooses to ignore the cancellation request.
   * - `ABANDON` - Do not request cancellation of the activity and immediately report cancellation to the workflow.
   */
  cancellationType?: coresdk.workflow_commands.ActivityCancellationType;
}
