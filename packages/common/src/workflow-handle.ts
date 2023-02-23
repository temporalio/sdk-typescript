import { Workflow, WorkflowResultType, SignalDefinition } from './interfaces';

/**
 * Base WorkflowHandle interface, extended in workflow and client libs.
 *
 * Transforms a workflow interface `T` into a client interface.
 */
export interface BaseWorkflowHandle<T extends Workflow> {
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
  signal<Args extends any[] = [], Name extends string = string>(
    def: SignalDefinition<Args, Name> | string,
    ...args: Args
  ): Promise<void>;

  /**
   * The workflowId of the current Workflow
   */
  readonly workflowId: string;
}
