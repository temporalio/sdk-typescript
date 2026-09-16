import type { BaseWorkflowHandle, SignalDefinition, Workflow, WorkflowSignalOptions } from '@temporalio/common';
import type { EventGroupsOptions } from './event-groups';

/**
 * Handle representing an external Workflow Execution.
 *
 * This handle only has methods `cancel`, `signal`, and `signalWithOptions`. To call other methods, like `query` and
 * `result`, use {@link WorkflowClient.getHandle} inside an Activity.
 */
export interface ExternalWorkflowHandle {
  /**
   * Signal a running Workflow.
   *
   * To provide call-site TypeInfo when signaling by name, use {@link signalWithOptions}.
   *
   * @param def a signal definition as returned from {@link defineSignal} or signal name (string)
   *
   * @example
   * ```ts
   * await handle.signal(incrementSignal, 3);
   * ```
   */
  signal<Args extends any[] = [], Name extends string = string>(
    def: SignalDefinition<Args, Name> | string,
    ...args: Args
  ): Promise<void>;

  /**
   * Signal a running Workflow by Signal name with additional options, including call-site TypeInfo
   * and Event Groups.
   *
   * @experimental
   */
  signalWithOptions<Args extends any[] = []>(
    signalName: string,
    options: WorkflowSignalOptions<Args> & EventGroupsOptions
  ): Promise<void>;

  /**
   * Cancel the external Workflow execution.
   *
   * Throws if the Workflow execution does not exist.
   *
   * @param options.eventGroups Event Groups to attach to the cancel command, in addition to those
   *     active in the current scope.
   */
  cancel(options?: EventGroupsOptions): Promise<void>;

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
  readonly firstExecutionRunId: string;

  /**
   * Signal a running Workflow by Signal name with additional options, including call-site TypeInfo
   * and Event Groups. Variadic {@link signal} cannot take an options object because Signal arguments
   * are already rest parameters.
   *
   * @experimental
   */
  signalWithOptions<Args extends any[] = []>(
    signalName: string,
    options: WorkflowSignalOptions<Args> & EventGroupsOptions
  ): Promise<void>;
}
