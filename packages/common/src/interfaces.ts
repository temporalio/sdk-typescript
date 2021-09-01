export type WorkflowReturnType = Promise<any>;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

/**
 * Generic workflow interface, extend this in order to validate your workflow interface definitions
 */
export interface Workflow {
  execute(...args: any[]): WorkflowReturnType;
  signals?: Record<string, WorkflowSignalType>;
  queries?: Record<string, WorkflowQueryType>;
}

/**
 * Implementation of Workflow interface `I`, same as `I` but execute does not take any args
 */
export type WorkflowImplementation<I extends Workflow> = {
  execute(): ReturnType<I['execute']>;
} & Pick<I, 'signals' | 'queries'>;

/**
 * Constructor of a `WorkflowImplementation` for interface `I`
 */
export interface WorkflowConstructor<I extends Workflow> {
  new (...args: Parameters<I['execute']>): WorkflowImplementation<I>;
}

/**
 * Factory function of a `WorkflowImplementation` for interface `I`
 */
export interface WorkflowFactory<I extends Workflow> {
  (...args: Parameters<I['execute']>): WorkflowImplementation<I>;
}

/**
 * Turns a constructor into a factory.
 *
 * Note that this method must be provided the template type `I` or Typescript
 * will infer the generic `Workflow` interface.
 */
export function workflowFactory<I extends Workflow>(ctor: WorkflowConstructor<I>): WorkflowFactory<I> {
  return (...args) => new ctor(...args);
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
