/** Type that can be returned from a Workflow `execute` function */
export type WorkflowReturnType = Promise<any>;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

/**
 * Generic Workflow execute, signal, and query handlers
 */
export interface WorkflowHandlers {
  execute(): WorkflowReturnType;
  signals?: Record<string, WorkflowSignalType>;
  queries?: Record<string, WorkflowQueryType>;
}

/**
 * Generic workflow interface, extend this in order to validate your workflow interface definitions
 */
export type Workflow = (...args: any[]) => WorkflowHandlers;

/** Get the execute handler from Workflow type `W` */
export type WorkflowExecuteHandler<W extends Workflow> = ReturnType<W>['execute'];
/** Get the "unwrapped" return type (without Promise) of the execute handler from Workflow type `W` */
export type WorkflowResultType<W extends Workflow> = ReturnType<WorkflowExecuteHandler<W>> extends Promise<infer R>
  ? R
  : never;
/** Get the signal handler definitions from Workflow type `W` */
export type WorkflowSignalHandlers<W extends Workflow> = ReturnType<W>['signals'];
/** Get the query handler definitions from Workflow type `W` */
export type WorkflowQueryHandlers<W extends Workflow> = ReturnType<W>['queries'];

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
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  initialInterval: string | number;
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
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  maximumInterval?: string | number;

  /**
   * List of application failures types to not retry.
   */
  nonRetryableErrorTypes?: string[];
}
