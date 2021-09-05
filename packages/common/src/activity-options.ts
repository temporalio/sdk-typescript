import { coresdk } from '@temporalio/proto/lib/coresdk';
import { RetryOptions } from './interfaces';

export const ActivityCancellationType = coresdk.workflow_commands.ActivityCancellationType;

/**
 * Options for local activity invocation - will be processed by the worker running the calling workflow.
 *
 * **Not yet implemented**
 */
export interface LocalActivityOptions {
  /**
   * Indicates this is a local activity invocation
   */
  type: 'local';
}

/**
 * Options for remote activity invocation - will be processed from a task queue.
 * @see https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/activity/ActivityOptions.Builder.html
 */
export interface RemoteActivityOptions {
  /**
   * Indicates this is a remote activity invocation.
   */
  type: 'remote';

  /**
   * Identifier to use for tracking the activity in Workflow history.
   * The `activityId` can be accessed by the activity function.
   * Does not need to be unique.
   *
   * @default an incremental sequence number
   */
  activityId?: string;

  /**
   * Namespace to schedule this activity in.
   * @default current worker namespace
   */
  namespace?: string;

  /**
   * Task queue name.
   *
   * @default current worker task queue
   */
  taskQueue?: string;

  /**
   * Heartbeat interval. Activity must heartbeat before this interval passes after a last heartbeat or activity start.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  heartbeatTimeout?: string | number;

  /**
   * RetryOptions that define how activity is retried in case of failure. If this is not set, then the server-defined default activity retry policy will be used. To ensure zero retries, set maximum attempts to 1.
   */
  retry?: RetryOptions;

  /**
   * Maximum time of a single Activity execution attempt.
Note that the Temporal Server doesn't detect Worker process failures directly. It relies on this timeout to detect that an Activity that didn't complete on time. So this timeout should be as short as the longest possible execution of the Activity body. Potentially long running Activities must specify {@link heartbeatTimeout} and call {@link activity.Context.heartbeat} periodically for timely failure detection.

   * Either this option or {@link scheduleToCloseTimeout} is required.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  startToCloseTimeout?: string | number;
  /**
   * Time that the Activity Task can stay in the Task Queue before it is picked up by a Worker. Do not specify this timeout unless using host specific Task Queues for Activity Tasks are being used for routing.
   * `scheduleToStartTimeout` is always non-retryable. Retrying after this timeout doesn't make sense as it would just put the Activity Task back into the same Task Queue.
   * @default unlimited
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  scheduleToStartTimeout?: string | number;

  /**
   * Total time that a workflow is willing to wait for Activity to complete.
   * `scheduleToCloseTimeout` limits the total time of an Activity's execution including retries (use {@link startToCloseTimeout} to limit the time of a single attempt).
   *
   * Either this option or {@link startToCloseTimeout} is required
   * @default unlimited
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  scheduleToCloseTimeout?: string | number;

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

/**
 * Used to configure the way activities are run
 */
export type ActivityOptions = RemoteActivityOptions | LocalActivityOptions;

export interface ActivityFunction<P extends any[], R> {
  (...args: P): Promise<R>;
}

/**
 * Mapping of Activity name to function
 */
export type ActivityInterface = Record<string, ActivityFunction<any[], any>>;
