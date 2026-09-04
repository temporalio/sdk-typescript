import {
  defaultPayloadConverter,
  type Payload,
  type PayloadConverter,
  type SerializationContext,
  type TypeInfo,
  fromPayloadWithTypeInfo,
} from '@temporalio/common';
import { operationRegistry } from './generated/services';

export function isSystemNexusOperation(service: string | undefined, operation: string | undefined): boolean {
  return (
    service != null &&
    operation != null &&
    operationRegistry.some((entry) => entry.service === service && entry.operation === operation)
  );
}

export function systemNexusOperationDefinition(service: string, operation: string) {
  return operationRegistry.find((entry) => entry.service === service && entry.operation === operation);
}

let currentUserPayloadConverter: PayloadConverter | undefined;

/**
 * Makes the current System Nexus operation's context-bound user converter
 * available to generated Workflow Service support conversion helpers.
 *
 * @internal
 */
export function withSystemNexusUserPayloadConverter<T>(
  converter: PayloadConverter,
  context: SerializationContext | undefined,
  fn: () => T
): T {
  const previous = currentUserPayloadConverter;
  currentUserPayloadConverter = {
    toPayload: (value, _context, hint) => converter.toPayload(value, context, hint),
    fromPayload: (payload, _context, hint) => converter.fromPayload(payload, context, hint),
    validateConverterHint: converter.validateConverterHint?.bind(converter),
  };
  try {
    return fn();
  } finally {
    currentUserPayloadConverter = previous;
  }
}

/** @internal Returns the user converter scoped by the System Nexus outer envelope. */
export function currentSystemNexusUserPayloadConverter(): PayloadConverter {
  if (currentUserPayloadConverter == null) {
    throw new Error('System Nexus user payload converter context is not active');
  }
  return currentUserPayloadConverter;
}

/** Decode the JSON envelope returned by the Worker runtime to its generated protobuf shape. */
export function deserializeSystemNexusOutput(
  service: string | undefined,
  operation: string | undefined,
  payload: Payload | undefined,
  converter: PayloadConverter,
  context: SerializationContext | undefined,
  outputType: TypeInfo | undefined
): unknown | undefined {
  if (!isSystemNexusOperation(service, operation) || payload == null) return undefined;
  return withSystemNexusUserPayloadConverter(converter, context, () =>
    fromPayloadWithTypeInfo(defaultPayloadConverter, payload, undefined, outputType)
  );
}
