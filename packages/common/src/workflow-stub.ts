import { Workflow, WorkflowSignalType } from './interfaces';
import { AsyncOnly, EnsurePromise } from './type-helpers';

export type WorkflowStubSignals<T extends Workflow> = T extends Record<'signals', Record<string, WorkflowSignalType>>
  ? {
      [P in keyof T['signals']]: AsyncOnly<T['signals'][P]>;
    }
  : undefined;

/**
 * Base WorkflowStub interface, extended in workflow and client libs.
 *
 * Transforms a workflow interface `T` into a client interface.
 */
export interface BaseWorkflowStub<T extends Workflow> {
  /**
   * Start the Workflow with arguments, returns a Promise that resolves when the Workflow execution completes
   */
  execute(...args: Parameters<T['main']>): EnsurePromise<ReturnType<T['main']>>;

  /**
   * Start the Workflow with arguments, returns a Promise that resolves with the execution runId
   */
  start(...args: Parameters<T['main']>): Promise<string /* runId */>;

  /**
   * Promise that resolves when Workflow execution completes
   */
  result(): EnsurePromise<ReturnType<T['main']>>;

  /**
   * A mapping of the different signals defined by Workflow interface `T` to callable functions.
   * Call to signal a running Workflow.
   *
   * @example
   * ```ts
   * await workflow.signal.increment(3);
   * ```
   */
  signal: WorkflowStubSignals<T>;

  /**
   * The workflowId of the current Workflow
   */
  readonly workflowId: string;
}
