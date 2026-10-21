import type { LoadedDataConverter } from '../../converter/data-converter';
import type { FailureConverter } from '../../converter/failure-converter';
import type { PayloadConverter } from '../../converter/payload-converter';
import type { SerializationContext } from '../../converter/serialization-context';

/**
 * Converters available during synchronous System Nexus transfer conversion.
 * Codecs run outside this scope.
 *
 * @internal
 */
export type SystemNexusDataConverter = Pick<LoadedDataConverter, 'payloadConverter' | 'failureConverter'>;

let currentPayloadConversion:
  | { converter: PayloadConverter; failureConverter: FailureConverter; context: SerializationContext | undefined }
  | undefined;

/** @internal */
export function withSystemNexusPayloadConversion<T>(
  dataConverter: SystemNexusDataConverter,
  context: SerializationContext | undefined,
  fn: () => T
): T {
  const previous = currentPayloadConversion;
  currentPayloadConversion = {
    converter: dataConverter.payloadConverter,
    failureConverter: dataConverter.failureConverter,
    context,
  };
  try {
    return fn();
  } finally {
    currentPayloadConversion = previous;
  }
}

/** @internal */
export function currentSystemNexusPayloadConversion(): {
  converter: PayloadConverter;
  failureConverter: FailureConverter;
  context: SerializationContext | undefined;
} {
  if (currentPayloadConversion == null) {
    throw new Error('System Nexus user payload converter context is not active');
  }
  return currentPayloadConversion;
}
