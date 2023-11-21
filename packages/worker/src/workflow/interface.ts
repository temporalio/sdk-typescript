import { type coresdk } from '@temporalio/proto';
import { type SinkCall } from '@temporalio/workflow';
import { type WorkflowCreateOptions } from '@temporalio/workflow/lib/interfaces';

export { WorkflowCreateOptions };

export interface Workflow {
  /**
   * Activate the Workflow.
   *
   * This method should return a completion after processing a single activation.
   * It is guaranteed that only a single activation will be processed concurrently for a Workflow execution.
   */
  activate(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion>;

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
