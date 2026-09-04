import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import { operationRegistry } from './generated/services';

export function isSystemNexusOperation(service: string | undefined, operation: string | undefined): boolean {
  return (
    service != null &&
    operation != null &&
    operationRegistry.some((entry) => entry.service === service && entry.operation === operation)
  );
}

/** Decode the JSON envelope returned by the Worker runtime to its generated protobuf shape. */
export function deserializeSystemNexusOutput(
  service: string | undefined,
  operation: string | undefined,
  payload: Payload | undefined
): unknown | undefined {
  if (!isSystemNexusOperation(service, operation) || payload == null) return undefined;
  return defaultPayloadConverter.fromPayload(payload);
}
