import type { temporal } from '@temporalio/proto';
import type { WorkflowOptions } from './workflow-options';
import type { WorkflowHandle } from './workflow-client';
import type { WorkflowSignalInput } from './interceptors';

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
     * Response link copied by the client from the start RPC's response: the `link` on a
     * StartWorkflowExecutionResponse (populated by servers newer than 1.27), or the `signalLink` on a
     * SignalWithStartWorkflowExecutionResponse (populated by servers that support CHASM signal
     * response links, 1.31 and up). A given options object only ever flows through one of those RPCs,
     * so at most one source can populate this; left unset otherwise.
     */
    responseLink?: temporal.api.common.v1.ILink;

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
 * The SDK-internal variant of {@link WorkflowSignalInput} that carries the
 * {@link InternalWorkflowSignalOptionsSymbol} payload used by the Temporal Nexus helpers to forward
 * request links and capture the response link. Kept off the public `WorkflowSignalInput` so the
 * symbol does not leak onto the interceptor surface.
 *
 * @internal
 * @hidden
 */
export type InternalWorkflowSignalInput = WorkflowSignalInput & InternalWorkflowSignalOptions;

/**
 * The SDK-internal surface of a `WorkflowHandle` used by the Temporal Nexus helpers to send a Signal
 * while forwarding request links and capturing the response link the server returns.
 *
 * The Nexus helpers obtain a handle via `WorkflowClient.getHandle`, attach an
 * {@link InternalWorkflowSignalOptionsSymbol} payload carrying the request links, call
 * `handle.signal(...)`, and then read back the `responseLink` the signal handler wrote onto that
 * same payload. This keeps the link-forwarding plumbing off the public `WorkflowClient` surface.
 *
 * @internal
 * @hidden
 */
export type InternalWorkflowHandle = WorkflowHandle & InternalWorkflowSignalOptions;
