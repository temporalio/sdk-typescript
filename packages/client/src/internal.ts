import type { temporal } from '@temporalio/proto';
import type { WorkflowOptions } from './workflow-options';
import type { ActivityOptions } from './activity-options';

/**
 * A symbol used to attach extra, SDK-internal options to the `WorkflowClient.start()`
 * or `ActivityClient.start()` call.
 *
 * These are notably used by the Temporal Nexus helpers.
 *
 * @internal
 * @hidden
 */
export const InternalNexusStartOptionsSymbol = Symbol.for('__temporal_internal_client_nexus_start_options');
export interface InternalNexusStartOptions {
  [InternalNexusStartOptionsSymbol]?: {
    /**
     * Request ID to be used for the start call.
     */
    requestId?: string;

    /**
     * Callbacks to be called by the server when this workflow reaches a terminal state.
     * Callback addresses must be whitelisted in the server's dynamic configuration.
     */
    completionCallbacks?: temporal.api.common.v1.ICallback[];

    /**
     * Links to be associated with the workflow or activity execution.
     */
    links?: temporal.api.common.v1.ILink[];

    /**
     * Backlink copied by the client from the start response.
     * Only populated in servers newer than 1.27.
     */
    backLink?: temporal.api.common.v1.ILink;

    /**
     * Conflict options for when USE_EXISTING is specified.
     *
     * Used by the Nexus Operations to attach to a callback to a running execution (workflow or activity).
     */
    onConflictOptions?: temporal.api.workflow.v1.IOnConflictOptions;
  };
}

export type InternalWorkflowStartOptions = WorkflowOptions & InternalNexusStartOptions;
export type InternalActivityStartOptions = ActivityOptions & InternalNexusStartOptions;
