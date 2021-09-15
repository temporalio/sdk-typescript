import { BaseWorkflowHandle, Workflow, WorkflowHandleSignals } from '@temporalio/common';

/**
 * Handle representing an external Workflow execution
 */
export interface ExternalWorkflowHandle<T extends Workflow> {
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
 * Transforms a workflow interface `T` into a client interface
 *
 * Given a workflow interface such as:
 * ```ts
 * export interface Counter {
 *   execute(initialValue?: number): number;
 *   signals: {
 *     increment(amount?: number): void;
 *   };
 * }
 * ```
 *
 * Create a handle for running and interacting with a single workflow
 * ```ts
 * // `counter` is a registered workflow file, typically found at
 * // `lib/workflows/counter.js` after building the typescript project
 * const workflow = Context.child<Counter>('counter');
 * // start workflow `execute` function with initialValue of 2 and await its completion
 * await workflow.execute(2);
 * ```
 */
export interface ChildWorkflowHandle<T extends Workflow> extends BaseWorkflowHandle<T> {} // eslint-disable-line @typescript-eslint/no-empty-interface
