// All timeouts and intervals accept ms format strings (see: https://www.npmjs.com/package/ms).

// See: https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/activity/ActivityOptions.Builder.html
export interface CommonActivityOptions {
  scheduleToCloseTimeout?: string;
  startToCloseTimeout?: string;
  scheduleToStartTimeout?: string;
  heartbeatTimeout?: string;
  /**
   * If not defined, will not retry, otherwise retry with given options
   */
  retry?: RetryOptions;
}

export interface LocalActivityOptions extends CommonActivityOptions {
  type: 'local';
}

export interface RemoteActivityOptions extends CommonActivityOptions {
  type: 'remote';
  taskQueue: string;
}

// See: https://www.javadoc.io/doc/io.temporal/temporal-sdk/latest/io/temporal/common/RetryOptions.Builder.html
export interface RetryOptions {
  backoffCoefficient?: number;
  initialInterval?: string;
  maximumAttempts?: number;
  maximumInterval?: string;
}

export type ActivityOptions = RemoteActivityOptions | LocalActivityOptions;

export interface ActivityFunction<P extends any[], R> {
  (...args: P): Promise<R>;
}

export type CancellationFunction = (err: any) => void;

export type WorkflowReturnType = any;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

export interface Workflow {
  main(...args: any[]): WorkflowReturnType;
  signals?: Record<string, WorkflowSignalType>;
  queries?: Record<string, WorkflowQueryType>;
}
