import type { PayloadConverter, SerializationContext } from '@temporalio/common';

let currentUserPayloadConverter: PayloadConverter | undefined;

/** @internal */
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

/** @internal */
export function currentSystemNexusUserPayloadConverter(): PayloadConverter {
  if (currentUserPayloadConverter == null) {
    throw new Error('System Nexus user payload converter context is not active');
  }
  return currentUserPayloadConverter;
}
