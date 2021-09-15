import { Workflow, WorkflowSignalType, WorkflowSignalHandlers, WorkflowResultType } from './interfaces';
import { AsyncOnly } from './type-helpers';

export type WorkflowHandleSignals<T extends Workflow> = WorkflowSignalHandlers<T> extends Record<
  string,
  WorkflowSignalType
>
  ? {
      [P in keyof WorkflowSignalHandlers<T>]: AsyncOnly<WorkflowSignalHandlers<T>[P]>;
    }
  : undefined;

/**
 * Base WorkflowHandle interface, extended in workflow and client libs.
 *
 * Transforms a workflow interface `T` into a client interface.
 */
export interface BaseWorkflowHandle<T extends Workflow> {
  /**
   * Start the Workflow with arguments, returns a Promise that resolves when the Workflow execution completes
   */
  execute(...args: Parameters<T>): WorkflowResultType<T>;

  /**
   * Start the Workflow with arguments, returns a Promise that resolves with the execution runId
   */
  start(...args: Parameters<T>): Promise<string /* runId */>;

  /**
   * Promise that resolves when Workflow execution completes
   */
  result(): WorkflowResultType<T>;

  /**
   * A mapping of the different signals defined by Workflow interface `T` to callable functions.
   * Call to signal a running Workflow.
   *
   * @example
   * ```ts
   * await workflow.signal.increment(3);
   * ```
   */
  signal: WorkflowHandleSignals<T>;

  /**
   * The workflowId of the current Workflow
   */
  readonly workflowId: string;
}
