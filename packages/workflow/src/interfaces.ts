export * from './dependencies';

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
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  heartbeatTimeout?: string;

  /**
   * RetryOptions that define how activity is retried in case of failure. If this is not set, then the server-defined default activity retry policy will be used. To ensure zero retries, set maximum attempts to 1.
   */
  retry?: RetryOptions;

  /**
   * Maximum time of a single Activity execution attempt.
Note that the Temporal Server doesn't detect Worker process failures directly. It relies on this timeout to detect that an Activity that didn't complete on time. So this timeout should be as short as the longest possible execution of the Activity body. Potentially long running Activities must specify {@link heartbeatTimeout} and call {@link activity.Context.heartbeat} periodically for timely failure detection.

   * Either this option or {@link scheduleToCloseTimeout} is required.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  startToCloseTimeout?: string | number;
  /**
   * Time that the Activity Task can stay in the Task Queue before it is picked up by a Worker. Do not specify this timeout unless using host specific Task Queues for Activity Tasks are being used for routing.
   * `scheduleToStartTimeout` is always non-retryable. Retrying after this timeout doesn't make sense as it would just put the Activity Task back into the same Task Queue.
   * @default unlimited
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  scheduleToStartTimeout?: string | number;

  /**
   * Total time that a workflow is willing to wait for Activity to complete.
   * `scheduleToCloseTimeout` limits the total time of an Activity's execution including retries (use {@link startToCloseTimeout} to limit the time of a single attempt).
   *
   * Either this option or {@link startToCloseTimeout} is required
   * @default unlimited
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  scheduleToCloseTimeout?: string | number;
}

/**
 * Defines options for activity retries
 * @see {@link https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/common/RetryOptions.Builder.html | Java SDK definition}
 */
export interface RetryOptions {
  /**
   * Coefficient used to calculate the next retry interval.
   * The next retry interval is previous interval multiplied by this coefficient.
   * @minimum 1
   * @default 2
   */
  backoffCoefficient?: number;
  /**
   * Interval of the first retry.
   * If coefficient is 1 then it is used for all retries
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  initialInterval: string;
  /**
   * Maximum number of attempts. When exceeded the retries stop even if not expired yet.
   * @minimum 1
   * @default Infinity
   */
  maximumAttempts?: number;
  /**
   * Maximum interval between retries.
   * Exponential backoff leads to interval increase.
   * This value is the cap of the increase.
   *
   * @default 100x of {@link initialInterval}
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  maximumInterval?: string;
}

/**
 * Used to configure the way activities are run
 */
export type ActivityOptions = RemoteActivityOptions | LocalActivityOptions;

export interface ActivityFunction<P extends any[], R> {
  (...args: P): Promise<R>;
}

export type WorkflowReturnType = any;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

/**
 * Generic workflow interface, extend this in order to validate your workflow interface definitions
 */
export interface Workflow {
  main(...args: any[]): WorkflowReturnType;
  signals?: Record<string, WorkflowSignalType>;
  queries?: Record<string, WorkflowQueryType>;
}

/**
 * Workflow execution information
 */
export interface WorkflowInfo {
  /**
   * ID of the Workflow, this can be set by the client during Workflow creation.
   * A single Workflow may run multiple times e.g. when scheduled with cron.
   */
  workflowId: string;
  /**
   * ID of a single Workflow run
   */
  runId: string;

  /**
   * Filename containing the Workflow code
   */
  filename: string;

  /**
   * Namespace this Workflow is scheduled in
   */
  namespace: string;

  /**
   * Task queue this Workflow is scheduled in
   */
  taskQueue: string;

  /**
   * Whether a Workflow is replaying history or processing new events
   */
  isReplaying: boolean;
}
