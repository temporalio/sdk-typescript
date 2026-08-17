import type { Workflow, WorkflowResultType, SignalDefinition, SignalTypeInfo } from './interfaces';

/**
 * Options for signaling a Workflow by Signal name.
 *
 * @experimental
 */
export interface WorkflowSignalOptions<Args extends any[] = []> {
  /** Arguments to pass to the Signal handler. */
  args?: Args;

  /** Type information used to convert Signal arguments. */
  typeInfo?: SignalTypeInfo;
}

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
   * Signal a running Workflow by Signal name with additional options.
   *
   * @experimental
   */
  signalWithOptions<Args extends any[] = []>(signalName: string, options: WorkflowSignalOptions<Args>): Promise<void>;

  /**
   * The workflowId of the current Workflow
   */
  readonly workflowId: string;
}
