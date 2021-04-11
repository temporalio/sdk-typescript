/**
 * Options for local activity invocation
 * Not yet implemented
 */
export interface LocalActivityOptions {
  /**
   * Indicates this is a local activity invocation
   */
  type: 'local';
}

/**
 * Options for remote activity invocation
 * @see https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/activity/ActivityOptions.Builder.html
 */
export interface RemoteActivityOptions {
  /**
   * Indicates this is a remote activity invocation
   */
  type: 'remote';

  /**
   * Namespace to schedule this activity in
   * @default current worker namespace
   */
  namespace?: string;

  /**
   * Task queue name
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
   * Maximum activity execution time after it was sent to a worker.
   * If {@link scheduleToCloseTimeout} is not provided then both this and schedule to start are required.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  startToCloseTimeout?: string;
  /**
   * Time activity can stay in task queue before it is picked up by a worker. If {@link scheduleToCloseTimeout} is not provided then both this and {@link startToCloseTimeout} are required.

   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  scheduleToStartTimeout?: string;

  /**
   * Overall timeout workflow is willing to wait for activity to complete. It includes time in a task queue.
   * (use {@link scheduleToStartTimeout} to limit it plus activity execution time (use {@link startToCloseTimeout} to limit it).
   * Either this option or both {@link scheduleToStartTimeout} and {@link startToCloseTimeout} are required.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  scheduleToCloseTimeout?: string;
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

export type ActivityOptions = RemoteActivityOptions | LocalActivityOptions;

export interface ActivityFunction<P extends any[], R> {
  (...args: P): Promise<R>;
}

export interface Scope {
  parent?: Scope;
  requestCancel: CancellationFunction;
  completeCancel: CancellationFunction;
  associated: boolean;
}

export type CancellationFunction = (err: any) => void;
export type CancellationFunctionFactory = (reject: CancellationFunction, scope: Scope) => CancellationFunction;

export type WorkflowReturnType = any;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

export interface Workflow {
  main(...args: any[]): WorkflowReturnType;
  signals?: Record<string, WorkflowSignalType>;
  queries?: Record<string, WorkflowQueryType>;
}
