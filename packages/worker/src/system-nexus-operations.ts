import type { Service as ProtobufService, Type as ProtobufType } from 'protobufjs';
import type { Payload, PayloadConverter, SerializationContext, TypeInfo } from '@temporalio/common';
import { defaultPayloadConverter, fromPayloadWithTypeInfo, METADATA_MESSAGE_TYPE_KEY } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/protobufs';
import {
  decode,
  decodeSystemNexusEnvelopeBytes,
  SYSTEM_NEXUS_CONTEXT_METADATA_KEY,
  SYSTEM_NEXUS_PAYLOAD_METADATA_KEY,
  SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE,
} from '@temporalio/common/internal/internal-workflow';
import {
  isSerializationContext,
  type VisitOptions,
  visit,
  walkNexusTask,
  walkPayloadsInMessage,
} from '@temporalio/common/internal/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import type { coresdk } from '@temporalio/proto';
import { operationRegistry } from '@temporalio/workflow/lib/nexus/system/generated/registry';
import { withSystemNexusPayloadConversion } from '@temporalio/workflow/lib/nexus/system/user-payload-converter';

const protobufPayloadConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const protoRootWithLookup = protoRoot as typeof protoRoot & {
  lookupType(name: string): ProtobufType;
  lookupService(name: string): ProtobufService;
};
type SystemOperation = (typeof operationRegistry)[number];

function operationDefinition(
  service: string | null | undefined,
  operation: string | null | undefined
): SystemOperation | undefined {
  return operationRegistry.find((entry) => entry.service === service && entry.operation === operation);
}

/** The request type named by a System Nexus envelope's `messageType` metadata. */
export function systemNexusRequestType(payload: Payload): string {
  const value = payload.metadata?.[METADATA_MESSAGE_TYPE_KEY];
  return value == null ? '<missing>' : decode(value);
}

/** Whether `messageType` is the request type of a known System Nexus operation. */
export function isKnownSystemNexusRequestType(messageType: string): boolean {
  return operationRegistry.some(
    (entry) => requestMessageType(entry.service, entry.operation).fullName.replace(/^\./, '') === messageType
  );
}

/** Whether this payload is a marked System Nexus outer envelope. */
export function isSystemNexusEnvelope(payload: Payload | null | undefined): boolean {
  const marker = payload?.metadata?.[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY];
  return marker != null && bytesEqual(marker, SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE);
}

/** Parses the protobuf request carried by a marked System Nexus envelope. */
export function decodeSystemNexusEnvelope(payload: Payload): Record<string, unknown> {
  return protobufPayloadConverter.fromPayload<Record<string, unknown>>(payload);
}

/** Encodes `message` as the data of a copy of `envelope`, keeping its metadata (including the marker). */
export function encodeSystemNexusEnvelope(envelope: Payload, message: Record<string, unknown>): Payload {
  const encoded = protobufPayloadConverter.toPayload(message);
  if (encoded == null) throw new Error('failed to encode System Nexus protobuf envelope');
  return { ...envelope, data: encoded.data };
}

/** Converts a System Nexus request and applies the operation's input TypeInfo. */
export function fromSystemNexusPayload(
  payload: Payload,
  converter: PayloadConverter,
  typeInfo: TypeInfo | undefined
): unknown {
  return withSystemNexusPayloadConversion(converter, undefined, () =>
    fromPayloadWithTypeInfo(protobufPayloadConverter, payload, undefined, typeInfo)
  );
}

export interface EncodedSystemNexusInput {
  payload: Payload;
  context: SerializationContext | undefined;
}

/** Converts the isolate JSON envelope to the protobuf-binary server envelope. */
export async function encodeSystemNexusInput(
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined,
  workflowContext: SerializationContext,
  visitorOptions: Omit<VisitOptions<SerializationContext>, 'initialContext'>
): Promise<EncodedSystemNexusInput | undefined> {
  if (payload == null) return undefined;
  const definition = requireSystemOperation(service, operation);
  const metadataContext = contextFromMetadata(payload);
  if (definition.serializationContext != null && metadataContext == null) {
    throw new TypeError('missing System Nexus serialization context metadata');
  }
  const context = metadataContext ?? workflowContext;
  const properties = decodeSystemNexusEnvelopeBytes(defaultPayloadConverter.fromPayload(payload)) as Record<
    string,
    unknown
  >;
  const message = requestMessageType(service, operation).create(properties) as Record<string, unknown>;
  await visit(message, walkPayloadsInMessage, { ...visitorOptions, initialContext: context });
  const encoded = protobufPayloadConverter.toPayload(message);
  if (encoded == null) throw new Error('failed to encode System Nexus protobuf envelope');
  encoded.metadata ??= {};
  encoded.metadata[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY] = SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE;
  return { payload: encoded, context };
}

/** Applies a payload transformation to values nested in a protobuf-binary System Nexus envelope. */
export async function transformEncodedSystemNexusEnvelope<Ctx>(
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload,
  options: VisitOptions<Ctx>
): Promise<Payload> {
  requireSystemOperation(service, operation);
  const message = protobufPayloadConverter.fromPayload<Record<string, unknown>>(payload);
  await visit(message, walkPayloadsInMessage, options);
  const transformed = protobufPayloadConverter.toPayload(message);
  if (transformed == null) throw new Error('failed to encode System Nexus protobuf envelope');
  return transformed;
}

/**
 * Visits the payloads of a Nexus task. The payloads nested in a marked System Nexus start input are
 * visited instead of the envelope itself, so inbound passes (e.g. External Storage retrieval) reach
 * the user payloads the server placed inside the request.
 *
 * An envelope that cannot be parsed is left untouched for input decoding to reject.
 */
export async function visitNexusTask<Ctx>(task: coresdk.nexus.INexusTask, options: VisitOptions<Ctx>): Promise<void> {
  const start = task.task?.request?.startOperation;
  const envelope = start?.payload;
  if (start == null || envelope == null || !isSystemNexusEnvelope(envelope)) {
    await visit(task, walkNexusTask, options);
    return;
  }
  let message: Record<string, unknown>;
  try {
    message = decodeSystemNexusEnvelope(envelope);
  } catch {
    return;
  }
  // The start operation payload is the only payload in a Nexus task, so walking the nested request covers the task.
  await visit(message, walkPayloadsInMessage, options);
  start.payload = encodeSystemNexusEnvelope(envelope, message);
}

function contextFromMetadata(payload: Payload): SerializationContext | undefined {
  const value = payload.metadata?.[SYSTEM_NEXUS_CONTEXT_METADATA_KEY];
  if (value == null) return undefined;
  try {
    const context: unknown = JSON.parse(new TextDecoder().decode(value));
    if (!isSerializationContext(context)) {
      throw new TypeError('invalid System Nexus serialization context metadata');
    }
    return context;
  } catch {
    throw new TypeError('invalid System Nexus serialization context metadata');
  }
}

/** Converts the server protobuf-binary envelope to isolate JSON. */
export async function decodeSystemNexusOutput(
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined,
  context: SerializationContext,
  visitorOptions: Omit<VisitOptions<SerializationContext | undefined>, 'initialContext'>
): Promise<Payload | undefined> {
  if (payload == null) return undefined;
  const transformed = await transformEncodedSystemNexusEnvelope(service, operation, payload, {
    ...visitorOptions,
    initialContext: context,
  });
  return defaultPayloadConverter.toPayload(protobufPayloadConverter.fromPayload(transformed)) ?? undefined;
}

function requireSystemOperation(
  service: string | null | undefined,
  operation: string | null | undefined
): SystemOperation {
  const definition = operationDefinition(service, operation);
  if (definition == null) {
    throw new TypeError(`unsupported System Nexus operation: ${service}/${operation}`);
  }
  return definition;
}

function requestMessageType(service: string | null | undefined, operation: string | null | undefined): ProtobufType {
  if (service == null || operation == null) {
    throw new TypeError(`System Nexus operation is missing service or operation: ${service}/${operation}`);
  }
  const serviceDefinition = protoRootWithLookup.lookupService(service);
  const method = serviceDefinition.methods[operation];
  if (method == null) {
    throw new TypeError(`System Nexus operation is not present in protobuf descriptors: ${service}/${operation}`);
  }
  return serviceDefinition.lookupType(method.requestType);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
