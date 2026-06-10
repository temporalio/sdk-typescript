import type { temporal } from '@temporalio/proto';
import type { WorkflowOptions } from './workflow-options';

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
     * Backlink copied by the client from the StartWorkflowExecutionResponse.
     * Only populated in servers newer than 1.27.
     */
    backLink?: temporal.api.common.v1.ILink;

    /**
     * Backlink copied by the client from the SignalWithStartWorkflowExecutionResponse.
     * Only populated by servers that support CHASM signal backlinks (1.31 and up); left unset
     * otherwise.
     */
    signalBackLink?: temporal.api.common.v1.ILink;

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
 * Used by the Temporal Nexus helpers to forward inbound Nexus task links onto the signal request
 * and to capture the backlink returned on the SignalWorkflowExecutionResponse.
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
     * Backlink copied by the client from the SignalWorkflowExecutionResponse.
     * Only populated by servers that support CHASM signal backlinks (1.31 and up); left unset
     * otherwise.
     */
    backLink?: temporal.api.common.v1.ILink;
  };
}
