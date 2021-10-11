import { Workflow, WorkflowResultType, SignalDefinition } from './interfaces';

/**
 * Base WorkflowHandle interface, extended in workflow and client libs.
 *
 * Transforms a workflow interface `T` into a client interface.
 */
export interface BaseWorkflowHandle<T extends Workflow> {
  /**
   * Start the Workflow with arguments, returns a Promise that resolves when the Workflow execution completes
   */
  execute(...args: Parameters<T>): Promise<WorkflowResultType<T>>;

  /**
   * Start the Workflow with arguments, returns a Promise that resolves with the execution runId
   */
  start(...args: Parameters<T>): Promise<string /* runId */>;

  /**
   * Promise that resolves when Workflow execution completes
   */
  result(): Promise<WorkflowResultType<T>>;

  /**
   * Signal a running Workflow.
   *
   * @param def a signal definition as returned from {@link defineSignal}
   *
   * @example
   * ```ts
   * await handle.signal(incrementSignal, 3);
   * ```
   */
  signal<Args extends any[]>(def: SignalDefinition<Args>, ...args: Args): Promise<void>;

  /**
   * The workflowId of the current Workflow
   */
  readonly workflowId: string;
}
