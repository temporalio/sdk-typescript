import { defaultPayloadConverter } from '@temporalio/common';
import type { Payload } from '@temporalio/common';
import { operationRegistry } from './generated/service';

function operationDefinition(service: string, operation: string) {
  return operationRegistry.find((op) => op.service === service && op.operation === operation);
}

export function trySerializeSystemNexusInputToJsonPayload(
  service: string,
  operation: string,
  value: unknown
): Payload | undefined {
  const op = operationDefinition(service, operation);
  if (op == null) return undefined;
  return defaultPayloadConverter.toPayload(value ?? {});
}

export function tryDeserializeSystemNexusOutputFromJsonPayload(
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined
): unknown | undefined {
  if (service == null || operation == null || payload == null) return undefined;
  const op = operationDefinition(service, operation);
  if (op == null) return undefined;
  return defaultPayloadConverter.fromPayload(payload);
}
