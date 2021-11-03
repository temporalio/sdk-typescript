import { v4 as uuid4 } from 'uuid';
import {
  WithWorkflowArgs,
  WorkflowOptions as CommonWorkflowOptions,
  WorkflowOptionsWithDefaults as CommonWorkflowOptionsWithDefaults,
  SignalDefinition,
  Workflow,
} from '@temporalio/common';

export { CompiledWorkflowOptions, compileWorkflowOptions } from '@temporalio/common';

export interface WorkflowOptions extends CommonWorkflowOptions {
  /**
   * Task queue to use for Workflow tasks. It should match a task queue specified when creating a
   * `Worker` that hosts the Workflow code.
   */
  taskQueue: string;

  followRuns?: boolean;
}

export interface WorkflowSignalWithStartOptions<SA extends any[] = []> extends Partial<WorkflowOptions> {
  /**
   * SignalDefinition or name of signal
   */
  signal: SignalDefinition<SA> | string;
  /**
   * Arguments to invoke the signal handler with
   */
  signalArgs: SA;
}

export interface WorkflowOptionsWithDefaults<T extends Workflow> extends CommonWorkflowOptionsWithDefaults<T> {
  /**
   * If set to true, instructs the client to follow the chain of execution before returning a Workflow's result.
   *
   * Workflow execution is chained if the Workflow has a cron schedule or continues-as-new or configured to retry
   * after failure or timeout.
   *
   * @default true
   */
  followRuns: boolean;
}

/**
 * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
 */
export function addDefaults<T extends Workflow>(
  opts: WithWorkflowArgs<T, WorkflowOptions>
): WorkflowOptionsWithDefaults<T> {
  const { workflowId, args, ...rest } = opts;
  return {
    followRuns: true,
    args: args ?? [],
    workflowId: workflowId ?? uuid4(),
    ...rest,
  };
}
