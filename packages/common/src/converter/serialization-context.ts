import type { LoadedDataConverter } from './data-converter';
import type { FailureConverter } from './failure-converter';
import type { PayloadCodec } from './payload-codec';
import type { PayloadConverter } from './payload-converter';

/**
 * Context passed to data conversion interfaces so they can adjust serialization behavior.
 */
export interface SerializationContext {}

/**
 * Base context for serialization operations that are tied to a workflow execution.
 */
export interface HasWorkflowSerializationContext extends SerializationContext {
  namespace: string;
  workflowId: string;
}

/**
 * Context for workflow-level serialization operations.
 */
export interface WorkflowSerializationContext extends HasWorkflowSerializationContext {}

/**
 * Context for activity-level serialization operations.
 */
export interface ActivitySerializationContext extends HasWorkflowSerializationContext {
  workflowType: string;
  activityType: string;
  activityTaskQueue: string;
  isLocal: boolean;
}

export interface WithSerializationContext<T> {
  withContext(context: SerializationContext): T;
}

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
export function withLoadedDataConverterContext(
  converter: LoadedDataConverter,
  context: SerializationContext
): LoadedDataConverter {
  const payloadConverter = withPayloadConverterContext(converter.payloadConverter, context);
  const failureConverter = withFailureConverterContext(converter.failureConverter, context);

  let payloadCodecs = converter.payloadCodecs;
  for (let i = 0; i < converter.payloadCodecs.length; i++) {
    const codec = converter.payloadCodecs[i]!;
    const nextCodec = withPayloadCodecContext(codec, context);
    if (nextCodec !== codec) {
      if (payloadCodecs === converter.payloadCodecs) {
        payloadCodecs = converter.payloadCodecs.slice();
      }
      payloadCodecs[i] = nextCodec;
    }
  }

  if (
    payloadConverter === converter.payloadConverter &&
    failureConverter === converter.failureConverter &&
    payloadCodecs === converter.payloadCodecs
  ) {
    return converter;
  }
  return { payloadConverter, failureConverter, payloadCodecs };
}
