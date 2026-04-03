import type { LoadedDataConverter } from './data-converter';
import type { FailureConverter } from './failure-converter';
import type { PayloadConverter } from './payload-converter';

/**
 * Context for payloads owned by a workflow.
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
 * Context for payloads owned by an activity.
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
   * This may be omitted when context is supplied manually and the caller does
   * not know the activity ID.
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

/**
 * Return a payload converter bound to `context` if the converter supports context binding.
 */
export function withPayloadConverterContext(
  converter: PayloadConverter,
  context: SerializationContext
): PayloadConverter {
  return converter.withContext?.(context) ?? converter;
}

/**
 * Return a failure converter bound to `context` if the converter supports context binding.
 */
export function withFailureConverterContext(
  converter: FailureConverter,
  context: SerializationContext
): FailureConverter {
  return converter.withContext?.(context) ?? converter;
}

/**
 * Return a loaded data converter with its payload and failure converters bound to `context`.
 *
 * Payload codecs are intentionally left unchanged in this PR and will be handled separately.
 *
 * Internal helper for non-workflow code paths. Workflow-isolate code should bind the individual
 * payload or failure converter directly to avoid pulling unnecessary code into the workflow bundle.
 */
export function withSerializationContext(
  converter: LoadedDataConverter,
  context: SerializationContext
): LoadedDataConverter {
  const payloadConverter = withPayloadConverterContext(converter.payloadConverter, context);
  const failureConverter = withFailureConverterContext(converter.failureConverter, context);

  if (payloadConverter === converter.payloadConverter && failureConverter === converter.failureConverter) {
    return converter;
  }

  return {
    payloadConverter,
    failureConverter,
    payloadCodecs: converter.payloadCodecs,
  };
}
