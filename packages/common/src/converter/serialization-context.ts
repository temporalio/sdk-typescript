import type { LoadedDataConverter } from './data-converter';
import type { FailureConverter } from './failure-converter';
import type { PayloadCodec } from './payload-codec';
import type { PayloadConverter } from './payload-converter';

/**
 * Context for workflow-level serialization operations.
 */
export interface WorkflowSerializationContext {
  namespace: string;
  workflowId: string;
}

/**
 * Context for activity-level serialization operations.
 */
export interface ActivitySerializationContext extends WorkflowSerializationContext {
  workflowType: string;
  activityType: string;
  activityTaskQueue: string;
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
 */
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
  const payloadCodecs = codecsChanged ? maybeBoundCodecs : converter.payloadCodecs;

  if (
    payloadConverter === converter.payloadConverter &&
    failureConverter === converter.failureConverter &&
    !codecsChanged
  ) {
    return converter;
  }
  return { payloadConverter, failureConverter, payloadCodecs };
}
