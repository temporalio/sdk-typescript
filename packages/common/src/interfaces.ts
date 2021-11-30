/** Type that can be returned from a Workflow `execute` function */
export type WorkflowReturnType = Promise<any>;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

/**
 * Broad Workflow function definition, specific Workflows will typically use a narrower type definition, e.g:
 * ```ts
 * export async function myWorkflow(arg1: number, arg2: string): Promise<string>;
 * ```
 */
export type Workflow = (...args: any[]) => WorkflowReturnType;

/**
 * An interface representing a Workflow signal definition, as returned from {@link defineSignal}
 *
 * @remarks `_Args` can be used for parameter type inference in handler functions and *WorkflowHandle methods.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface SignalDefinition<_Args extends any[] = []> {
  type: 'signal';
  name: string;
}

/**
 * An interface representing a Workflow query definition as returned from {@link defineQuery}
 *
 * @remarks `_Args` and `_Ret` can be used for parameter type inference in handler functions and *WorkflowHandle methods.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface QueryDefinition<_Ret, _Args extends any[] = []> {
  type: 'query';
  name: string;
}

/** Get the "unwrapped" return type (without Promise) of the execute handler from Workflow type `W` */
export type WorkflowResultType<W extends Workflow> = ReturnType<W> extends Promise<infer R> ? R : never;

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
