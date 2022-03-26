import {
  CommonWorkflowOptions,
  SignalDefinition,
  WithCompiledWorkflowDurationOptions,
} from '@temporalio/internal-workflow-common';

export * from '@temporalio/internal-workflow-common/lib/workflow-options';

export interface CompiledWorkflowOptions extends WithCompiledWorkflowDurationOptions<WorkflowOptions> {
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

export interface WorkflowSignalWithStartOptions<SA extends any[] = []> extends WorkflowOptions {
  /**
   * SignalDefinition or name of signal
   */
  signal: SignalDefinition<SA> | string;
  /**
   * Arguments to invoke the signal handler with
   */
  signalArgs: SA;
}

// export interface WorkflowOptionsWithDefaults<T extends Workflow> extends CommonWorkflowOptionsWithDefaults<T> {
//   /**
//    * If set to true, instructs the client to follow the chain of execution before returning a Workflow's result.
//    *
//    * Workflow execution is chained if the Workflow has a cron schedule or continues-as-new or configured to retry
//    * after failure or timeout.
//    *
//    * @default true
//    */
//   followRuns: boolean;
// }
//
// /**
//  * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
//  */
// export function addDefaults<T extends Workflow>(
//   opts: WithWorkflowArgs<T, WorkflowOptions>
// ): WorkflowOptionsWithDefaults<T> {
//   const { workflowId, args, ...rest } = opts;
//   return {
//     followRuns: true,
//     args: args ?? [],
//     workflowId: workflowId ?? uuid4(),
//     ...rest,
//   };
// }
