/**
 * Context provided to data converters for payloads owned by a workflow.
 *
 * This is used when converting payloads sent to or received from a workflow.
 * If a workflow interacts with a child workflow or an external workflow, this
 * context refers to that target workflow.
 *
 * @experimental Serialization context is an experimental feature and may change.
 */
export interface WorkflowSerializationContext {
  /** Always `'workflow'` for workflow-owned payloads. */
  type: 'workflow';
  /** Namespace of the workflow that owns the payload. */
  namespace: string;
  /** Workflow ID of the workflow that owns the payload. */
  workflowId: string;
}

/**
 * Context provided to data converters for payloads owned by an activity.
 *
 * This is used when converting activity arguments, results, heartbeat details,
 * and activity-related failures.
 *
 * @experimental Serialization context is an experimental feature and may change.
 */
export interface ActivitySerializationContext {
  /** Always `'activity'` for activity-owned payloads. */
  type: 'activity';
  /** Namespace of the activity that owns the payload. */
  namespace: string;
  /**
   * Activity ID of the activity that owns the payload.
   *
   * Workflow-side scheduling contexts use the explicit
   * ActivityOptions.activityId when supplied, otherwise they use the same
   * generated fallback ID sent to the Temporal service. Runtime activity
   * contexts use the activity ID supplied by ActivityInfo or activity task data.
   */
  activityId?: string;
  /** Workflow ID of the workflow that scheduled the activity, when known. */
  workflowId?: string;
  /** Whether the activity is a local activity started from a workflow. */
  isLocal: boolean;
}

/**
 * Context passed to payload and failure converters.
 *
 * The context describes the workflow or activity whose payload is being converted.
 * For example:
 * - `client.workflow.start()` uses the target workflow's context.
 * - `executeChild()` uses the child workflow's context, not the parent's.
 * - `scheduleActivity()` uses the scheduled activity's context.
 *
 * @experimental Serialization context is an experimental feature and may change.
 */
export type SerializationContext = WorkflowSerializationContext | ActivitySerializationContext;
