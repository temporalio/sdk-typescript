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
 * Context provided to data converters for payloads of a Nexus operation.
 *
 * Callers receive this context when encoding inputs and decoding results or failures. Handlers
 * receive it when decoding inputs, encoding synchronous results, and encoding failures raised
 * while handling a Nexus task.
 *
 * Workflows and standalone Activities started by a handler, and Workflow Updates it sends, receive
 * this context through the server and use it for the payloads returned to the caller: results,
 * failures, and standalone Activity heartbeat details. Clients decode these with the context the server returns. See
 * `ActivityInfo.nexusSerializationContext` for asynchronous Activity completion.
 *
 * A standalone operation handle decodes with the context the server returns, falling back to the
 * context of its start request on older servers.
 *
 * A failure encoded by a handler is later decoded by a caller, and some operation paths lack this
 * context entirely. Contextual encodings must therefore be self-describing, and decoders must keep
 * accepting payloads encoded without context.
 *
 * @experimental Serialization context is an experimental feature and may change.
 */
export interface NexusSerializationContext {
  /** Always `'nexus'` for Nexus operation payloads. */
  type: 'nexus';
  /** Nexus endpoint name. */
  endpoint: string;
  /** Nexus service name. */
  service: string;
  /** Nexus operation name. */
  operation: string;
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
export type SerializationContext =
  | WorkflowSerializationContext
  | ActivitySerializationContext
  | NexusSerializationContext;

/** @internal */
// Consumed through the internal-non-workflow package entry point.
export function isSerializationContext(value: unknown): value is SerializationContext {
  if (value == null || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  if (context.type === 'nexus') {
    return (
      typeof context.endpoint === 'string' &&
      typeof context.service === 'string' &&
      typeof context.operation === 'string'
    );
  }
  if (typeof context.namespace !== 'string') return false;
  if (context.type === 'workflow') return typeof context.workflowId === 'string';
  return (
    context.type === 'activity' &&
    typeof context.isLocal === 'boolean' &&
    (context.activityId == null || typeof context.activityId === 'string') &&
    (context.workflowId == null || typeof context.workflowId === 'string')
  );
}

/**
 * Converts the Nexus serialization context the server propagates on executions started by a Nexus
 * operation handler.
 *
 * @internal
 */
// Consumed through the internal-workflow package entry point.
export function nexusSerializationContextFromProto(
  context: { endpoint?: string | null; service?: string | null; operation?: string | null } | null | undefined
): NexusSerializationContext | undefined {
  if (context == null) return undefined;
  return {
    type: 'nexus',
    endpoint: context.endpoint ?? '',
    service: context.service ?? '',
    operation: context.operation ?? '',
  };
}
