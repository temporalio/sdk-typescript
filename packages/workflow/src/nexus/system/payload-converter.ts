import {
  defaultPayloadConverter,
  type Payload,
  type PayloadConverter,
  type SerializationContext,
  type TypeInfo,
  fromPayloadWithTypeInfo,
} from '@temporalio/common';
import { operationRegistry } from './generated/registry';
import { withSystemNexusUserPayloadConverter } from './user-payload-converter';

export function isSystemNexusOperation(service: string | undefined, operation: string | undefined): boolean {
  return (
    service != null &&
    operation != null &&
    operationRegistry.some((entry) => entry.service === service && entry.operation === operation)
  );
}

export function systemNexusOperationDefinition(
  service: string,
  operation: string
): (typeof operationRegistry)[number] | undefined {
  return operationRegistry.find((entry) => entry.service === service && entry.operation === operation);
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
