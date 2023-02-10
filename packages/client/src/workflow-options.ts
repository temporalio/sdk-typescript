import {
  CommonWorkflowOptions,
  SignalDefinition,
  WithCompiledWorkflowOptions,
  WithWorkflowArgs,
  Workflow,
} from '@temporalio/common';

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
   * Workflow IDs are unique, see also {@link WorkflowOptions.workflowIdReusePolicy}
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
