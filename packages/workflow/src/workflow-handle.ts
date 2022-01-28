import { BaseWorkflowHandle, SignalDefinition, Workflow } from '@temporalio/workflow-common';

/**
 * Handle representing an external Workflow execution
 */
export interface ExternalWorkflowHandle {
  /**
   * Signal a running Workflow.
   *
   * @param def a signal definition as returned from {@link defineSignal} or signal name (string)
   *
   * @example
   * ```ts
   * await handle.signal(incrementSignal, 3);
   * ```
   */
  signal<Args extends any[] = []>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void>;

  /**
   * Cancel the external Workflow execution.
   *
   * Throws if the Workflow execution does not exist.
   */
  cancel(): Promise<void>;

  /**
   * The workflowId of the external Workflow
   */
  readonly workflowId: string;

  /**
   * An optional runId of the external Workflow
   */
  readonly runId?: string;
}

/**
 * A client side handle to a single Workflow instance.
 * It can be used to signal, wait for completion, and cancel a Workflow execution.
 *
 * Given the following Workflow definition:
 * ```ts
 * export const incrementSignal = defineSignal('increment');
 * export async function counterWorkflow(initialValue: number): Promise<void>;
 * ```
 *
 * Start a new Workflow execution and get a handle for interacting with it:
 * ```ts
 * // Start the Workflow with initialValue of 2.
 * const handle = await startWorkflow(counterWorkflow, { args: [2] });
 * await handle.signal(incrementSignal, 2);
 * await handle.result(); // throws WorkflowExecutionTerminatedError
 * ```
 */
export interface ChildWorkflowHandle<T extends Workflow> extends BaseWorkflowHandle<T> {
  /**
   * The runId of the initial run of the bound Workflow
   */
  readonly originalRunId: string;
}
