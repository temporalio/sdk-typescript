import type { temporal } from '@temporalio/proto';
import type { WorkflowOptions } from './workflow-options';
import type { WorkflowExecution } from './types';

/**
 * A symbol used to attach extra, SDK-internal options to the `WorkflowClient.start()` call.
 *
 * These are notably used by the Temporal Nexus helpers.
 *
 * @internal
 * @hidden
 */
export const InternalWorkflowStartOptionsSymbol = Symbol.for('__temporal_internal_client_workflow_start_options');
export interface InternalWorkflowStartOptions extends WorkflowOptions {
  [InternalWorkflowStartOptionsSymbol]?: {
    /**
     * Request ID to be used for the workflow.
     */
    requestId?: string;

    /**
     * Callbacks to be called by the server when this workflow reaches a terminal state.
     * If the workflow continues-as-new, these callbacks will be carried over to the new execution.
     * Callback addresses must be whitelisted in the server's dynamic configuration.
     */
    completionCallbacks?: temporal.api.common.v1.ICallback[];

    /**
     * Links to be associated with the workflow.
     */
    links?: temporal.api.common.v1.ILink[];

    /**
     * Response link copied by the client from the StartWorkflowExecutionResponse.
     * Only populated in servers newer than 1.27.
     */
    responseLink?: temporal.api.common.v1.ILink;

    /**
     * Response link copied by the client from the SignalWithStartWorkflowExecutionResponse.
     * Only populated by servers that support CHASM signal response links (1.31 and up); left unset
     * otherwise.
     */
    signalResponseLink?: temporal.api.common.v1.ILink;

    /**
     * Conflict options for when USE_EXISTING is specified.
     *
     * Used by the Nexus WorkflowRunOperations to attach to a callback to a running workflow.
     */
    onConflictOptions?: temporal.api.workflow.v1.IOnConflictOptions;
  };
}

/**
 * A symbol used to attach extra, SDK-internal options to a `WorkflowHandle.signal()` call.
 *
 * Used by the Temporal Nexus helpers to forward request links onto the signal request
 * and to capture the response link returned on the SignalWorkflowExecutionResponse.
 *
 * @internal
 * @hidden
 */
export const InternalWorkflowSignalOptionsSymbol = Symbol.for('__temporal_internal_client_workflow_signal_options');
export interface InternalWorkflowSignalOptions {
  [InternalWorkflowSignalOptionsSymbol]?: {
    /**
     * Links to be associated with the WorkflowExecutionSignaled event.
     */
    links?: temporal.api.common.v1.ILink[];

    /**
     * Response link copied by the client from the SignalWorkflowExecutionResponse.
     * Only populated by servers that support CHASM signal response links (1.31 and up); left unset
     * otherwise.
     */
    responseLink?: temporal.api.common.v1.ILink;
  };
}

/**
 * The SDK-internal surface of `WorkflowClient` used by the Temporal Nexus helpers to send a Signal
 * while forwarding request links and capturing the response link the server returns.
 *
 * This mirrors the typed-symbol approach used by the start / signalWithStart paths (see
 * {@link InternalWorkflowStartOptionsSymbol}), letting the Nexus helpers call the internal method
 * type-safely instead of casting through `any`.
 *
 * @internal
 * @hidden
 */
export interface InternalWorkflowClientWithNexusLinks {
  /**
   * Signal a Workflow Execution, forwarding the given links onto the request and returning the
   * response link the server attached to the response (if any). Not part of the public API.
   */
  _signalWorkflowWithNexusLinks(
    workflowExecution: WorkflowExecution,
    signalName: string,
    args: unknown[],
    links: temporal.api.common.v1.ILink[]
  ): Promise<temporal.api.common.v1.ILink | undefined>;
}
