import type { LoadedDataConverter } from './data-converter';
import type { FailureConverter } from './failure-converter';
import type { PayloadCodec } from './payload-codec';
import type { PayloadConverter } from './payload-converter';

/**
 * Context for workflow-level serialization operations.
 */
export interface WorkflowSerializationContext {
  /** Discriminant for narrowing the {@link SerializationContext} union. */
  type: 'workflow';
  /** Namespace of the workflow. */
  namespace: string;
  /**
   * ID of the workflow that owns the payload being serialized.
   *
   * When creating/describing schedules, this may be the workflow ID prefix
   * as configured, not the final workflow ID when the workflow is created.
   */
  workflowId: string;
  /** Workflow type name, when available. */
  workflowType?: string;
}

/**
 * Context for activity-level serialization operations.
 */
export interface ActivitySerializationContext {
  /** Discriminant for narrowing the {@link SerializationContext} union. */
  type: 'activity';
  /** Namespace of the activity. */
  namespace: string;
  /** Activity ID for this execution when provided by the activity context source. */
  activityId?: string;
  /** Parent workflow ID when this activity is associated with a workflow. */
  workflowId?: string;
  /** Parent workflow type when this activity is associated with a workflow. */
  workflowType?: string;
  /** Whether the activity is a local activity started from a workflow. */
  isLocal: boolean;
}

/**
 * Context passed to data conversion interfaces so they can adjust serialization behavior.
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
 * Return a payload codec bound to `context` if the codec supports context binding.
 */
export function withPayloadCodecContext(codec: PayloadCodec, context: SerializationContext): PayloadCodec {
  return codec.withContext?.(context) ?? codec;
}

/**
 * Return a loaded data converter where all components are context-bound when supported.
 *
 * **Internal — worker main thread only.** Do not call from within the workflow sandbox;
 * doing so would pull unnecessary code into the workflow bundle, increasing memory footprint.
 * Inside the sandbox, use the individual `withPayloadConverterContext` / `withFailureConverterContext`
 * helpers instead.
 *
 * Uses identity (`===`) checks to skip allocation when no converter actually changed.
 * A `withContext` implementation that returns a new object with identical behaviour will
 * defeat this optimisation but is otherwise harmless.
 */
// ts-prune-ignore-next (imported via lib/converter/serialization-context)
export function withSerializationContext(
  converter: LoadedDataConverter,
  context: SerializationContext
): LoadedDataConverter {
  const payloadConverter = withPayloadConverterContext(converter.payloadConverter, context);
  const failureConverter = withFailureConverterContext(converter.failureConverter, context);
  let codecsChanged = false;
  const maybeBoundCodecs = converter.payloadCodecs.map((codec) => {
    const maybeContextCodec = withPayloadCodecContext(codec, context);
    if (maybeContextCodec !== codec) {
      codecsChanged = true;
    }
    return maybeContextCodec;
  });

  if (
    payloadConverter === converter.payloadConverter &&
    failureConverter === converter.failureConverter &&
    !codecsChanged
  ) {
    return converter;
  }
  return {
    payloadConverter,
    failureConverter,
    payloadCodecs: codecsChanged ? maybeBoundCodecs : converter.payloadCodecs,
  };
}
