import { CommonWorkflowOptions, SignalDefinition, WithWorkflowArgs, Workflow } from '@temporalio/common';
import { Duration, msOptionalToTs } from '@temporalio/common/lib/time';
import { Replace } from '@temporalio/common/lib/type-helpers';
import { google } from '@temporalio/proto';

export * from '@temporalio/common/lib/workflow-options';

export interface CompiledWorkflowOptions extends WithCompiledWorkflowOptions<WorkflowOptions> {
  args: unknown[];
}

export interface WorkflowOptions extends CommonWorkflowOptions {
  /**
   * Workflow id to use when starting.
   *
   * Assign a meaningful business id.
   * This ID can be used to ensure starting Workflows is idempotent.
   * Workflow IDs are unique: see {@link WorkflowOptions.workflowIdReusePolicy}
   * and {@link WorkflowOptions.workflowIdConflictPolicy}.
   */
  workflowId: string;

  /**
   * Task queue to use for Workflow tasks. It should match a task queue specified when creating a
   * `Worker` that hosts the Workflow code.
   */
  taskQueue: string;

  /**
   * If set to true, instructs the client to follow the chain of execution before returning a Workflow's result.
   *
   * Workflow execution is chained if the Workflow has a cron schedule or continues-as-new or configured to retry
   * after failure or timeout.
   *
   * @default true
   */
  followRuns?: boolean;

  /**
   * Amount of time to wait before starting the workflow.
   *
   */
  startDelay?: Duration;
}

export type WithCompiledWorkflowOptions<T extends WorkflowOptions> = Replace<
  T,
  {
    workflowExecutionTimeout?: google.protobuf.IDuration;
    workflowRunTimeout?: google.protobuf.IDuration;
    workflowTaskTimeout?: google.protobuf.IDuration;
    startDelay?: google.protobuf.IDuration;
  }
>;

export function compileWorkflowOptions<T extends WorkflowOptions>(options: T): WithCompiledWorkflowOptions<T> {
  const { workflowExecutionTimeout, workflowRunTimeout, workflowTaskTimeout, startDelay, ...rest } = options;

  return {
    ...rest,
    workflowExecutionTimeout: msOptionalToTs(workflowExecutionTimeout),
    workflowRunTimeout: msOptionalToTs(workflowRunTimeout),
    workflowTaskTimeout: msOptionalToTs(workflowTaskTimeout),
    startDelay: msOptionalToTs(startDelay),
  };
}

export interface WorkflowUpdateOptions {
  /**
   * The Update Id, which is a unique-per-Workflow-Execution identifier for this Update.
   *
   * We recommend setting it to a meaningful business ID or idempotency key (like a request ID) passed from upstream. If
   * it is not provided, it will be set to a random string by the Client. If the Server receives two Updates with the
   * same Update Id to a Workflow Execution with the same Run Id, the second Update will return a handle to the first
   * Update.
   */
  readonly updateId?: string;
}

export type WorkflowSignalWithStartOptions<SignalArgs extends any[] = []> = SignalArgs extends [any, ...any[]]
  ? WorkflowSignalWithStartOptionsWithArgs<SignalArgs>
  : WorkflowSignalWithStartOptionsWithoutArgs<SignalArgs>;

export interface WorkflowSignalWithStartOptionsWithoutArgs<SignalArgs extends any[]> extends WorkflowOptions {
  /**
   * SignalDefinition or name of signal
   */
  signal: SignalDefinition<SignalArgs> | string;

  /**
   * Arguments to invoke the signal handler with
   */
  signalArgs?: SignalArgs;
}

export interface WorkflowSignalWithStartOptionsWithArgs<SignalArgs extends any[]> extends WorkflowOptions {
  /**
   * SignalDefinition or name of signal
   */
  signal: SignalDefinition<SignalArgs> | string;

  /**
   * Arguments to invoke the signal handler with
   */
  signalArgs: SignalArgs;
}

/**
 * Options for starting a Workflow
 */
export type WorkflowStartOptions<T extends Workflow = Workflow> = WithWorkflowArgs<T, WorkflowOptions>;
