import { temporal } from '@temporalio/proto';

// A key used internally to pass "hidden options to the WorkflowClient.start() call.
export const InternalWorkflowStartOptionsKey = Symbol.for('__temporal_client_internal_workflow_start_options');
export interface InternalWorkflowStartOptions {
  requestId?: string;
  /**
   * Callbacks to be called by the server when this workflow reaches a terminal state.
   * If the workflow continues-as-new, these callbacks will be carried over to the new execution.
   * Callback addresses must be whitelisted in the server's dynamic configuration.
   */
  completionCallbacks?: temporal.api.common.v1.ICallback[];
  /** Links to be associated with the workflow. */
  links?: temporal.api.common.v1.ILink[];
  /**
   * Backlink copied by the client from the StartWorkflowExecutionResponse. Only populated in servers newer than 1.27.
   */
  backLink?: temporal.api.common.v1.ILink;

  /**
   * Conflict options for when USE_EXISTING is specified.
   *
   * Used by the nexus WorkflowRunOperations to attach to a callback to a running workflow.
  */
  onConflictOptions?: temporal.api.workflow.v1.IOnConflictOptions;
}
