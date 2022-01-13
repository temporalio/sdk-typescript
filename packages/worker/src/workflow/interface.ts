import { coresdk } from '@temporalio/proto';
import { SinkCall } from '@temporalio/workflow';
import { WorkflowCreateOptions } from '@temporalio/workflow/lib/worker-interface';
export { WorkflowCreateOptions };

export interface Workflow {
  /**
   * Activate the Workflow.
   *
   * This method should return a serialized {@link coresdk.workflow_completion.WorkflowActivationCompletion}
   * after processing a single activation.
   * It is guaranteed to that only a single activation will be processed concurrently for a Workflow execution.
   */
  activate(activation: coresdk.workflow_activation.IWorkflowActivation): Promise<Uint8Array>;

  /**
   * Gets any sink calls recorded during an activation.
   *
   * This is separate from `activate` so it can be called even if activation fails
   * in order to extract all logs and metrics from the Workflow context.
   */
  getAndResetSinkCalls(): Promise<SinkCall[]>;

  /**
   * Dispose this instance, and release its resources.
   *
   * Do not use this Workflow instance after this method has been called.
   */
  dispose(): Promise<void>;
}

export interface WorkflowCreator {
  /**
   * Create a Workflow for the Worker to activate
   */
  createWorkflow(options: WorkflowCreateOptions): Promise<Workflow>;

  /**
   * Destroy and cleanup any resources
   */
  destroy(): Promise<void>;
}
