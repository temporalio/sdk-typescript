import type { PayloadConverter, SerializationContext } from '@temporalio/common';

let currentPayloadConversion: { converter: PayloadConverter; context: SerializationContext | undefined } | undefined;

/** @internal */
export function withSystemNexusPayloadConversion<T>(
  converter: PayloadConverter,
  context: SerializationContext | undefined,
  fn: () => T
): T {
  const previous = currentPayloadConversion;
  currentPayloadConversion = { converter, context };
  try {
    return fn();
  } finally {
    currentPayloadConversion = previous;
  }
}

/** @internal */
export function currentSystemNexusPayloadConversion(): {
  converter: PayloadConverter;
  context: SerializationContext | undefined;
} {
  if (currentPayloadConversion == null) {
    throw new Error('System Nexus user payload converter context is not active');
  }
  return currentPayloadConversion;
}
