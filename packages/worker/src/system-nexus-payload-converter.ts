import type { Service as ProtobufService, Type as ProtobufType } from 'protobufjs';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import { decode, encode, visit, walkPayloadsInMessage } from '@temporalio/common/lib/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import { operationRegistry } from '@temporalio/workflow/lib/nexus/system/generated/services';

const protobufPayloadConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const protoRootWithLookup = protoRoot as typeof protoRoot & {
  lookupType(name: string): ProtobufType;
  lookupService(name: string): ProtobufService;
};
export const TEMPORAL_SYSTEM_NEXUS_ENDPOINT = '__temporal_system';
const SYSTEM_NEXUS_PAYLOAD_METADATA_KEY = '__temporal_system_payload';
const SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE = new Uint8Array([116, 114, 117, 101]); // "true"
const SYSTEM_NEXUS_CONTEXT_METADATA_KEY = '__temporal_system_context';

type SystemOperation = (typeof operationRegistry)[number];

function operationDefinition(
  service: string | null | undefined,
  operation: string | null | undefined
): SystemOperation | undefined {
  return operationRegistry.find((entry) => entry.service === service && entry.operation === operation);
}

/** Whether this is a marked System Nexus outer envelope on the reserved endpoint. */
export function isSystemNexusEnvelope(
  endpoint: string | null | undefined,
  payload: Payload | null | undefined
): boolean {
  if (endpoint !== TEMPORAL_SYSTEM_NEXUS_ENDPOINT || payload == null) return false;
  const marker = payload.metadata?.[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY];
  return marker != null && bytesEqual(marker, SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE);
}

export interface EncodedSystemNexusInput {
  payload: Payload;
  context: SerializationContext | undefined;
}

/** Converts the isolate JSON envelope to the protobuf-binary server envelope. */
export async function encodeSystemNexusInput(
  codecs: PayloadCodec[],
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined,
  workflowContext: SerializationContext
): Promise<EncodedSystemNexusInput | undefined> {
  const definition = operationDefinition(service, operation);
  if (payload == null) return undefined;
  if (definition == null) {
    throw new TypeError(`unsupported System Nexus operation: ${service}/${operation}`);
  }
  const context = contextFromMetadata(payload) ?? workflowContext;
  const properties = defaultPayloadConverter.fromPayload(payload) as Record<string, unknown>;
  normalizePayloadBytes(properties);
  const message = requestMessageType(service, operation).create(properties) as Record<string, unknown>;
  await visit(message, walkPayloadsInMessage, {
    initialContext: context,
    transformPayload: async (value, valueContext) => (await encode(codecs, [value], valueContext))[0]!,
    transformPayloads: (values, valueContext) => encode(codecs, values, valueContext),
    skipSearchAttributes: true,
  });
  const encoded = protobufPayloadConverter.toPayload(message);
  if (encoded == null) throw new Error('failed to encode System Nexus protobuf envelope');
  return { payload: encoded, context };
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

function isSerializationContext(value: unknown): value is SerializationContext {
  if (value == null || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  if (typeof context.namespace !== 'string') return false;
  if (context.type === 'workflow') return typeof context.workflowId === 'string';
  return (
    context.type === 'activity' &&
    typeof context.isLocal === 'boolean' &&
    (context.activityId == null || typeof context.activityId === 'string') &&
    (context.workflowId == null || typeof context.workflowId === 'string')
  );
}

/** Converts the server protobuf-binary envelope to isolate JSON. */
export async function decodeSystemNexusOutput(
  codecs: PayloadCodec[],
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined,
  context: SerializationContext
): Promise<Payload | undefined> {
  const definition = operationDefinition(service, operation);
  if (payload == null) return undefined;
  if (definition == null) {
    throw new TypeError(`unsupported System Nexus operation: ${service}/${operation}`);
  }
  const message = protobufPayloadConverter.fromPayload<Record<string, unknown>>(payload);
  await visit(message, walkPayloadsInMessage, {
    initialContext: context,
    transformPayload: async (value, valueContext) => (await decode(codecs, [value], valueContext))[0]!,
    transformPayloads: (values, valueContext) => decode(codecs, values, valueContext),
    skipSearchAttributes: true,
  });
  return defaultPayloadConverter.toPayload(message) ?? undefined;
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

function normalizePayloadBytes(value: unknown, seen = new Set<object>()): void {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if ('metadata' in value && ('data' in value || (value as Payload).data == null)) {
    const payload = value as Payload;
    if (payload.data != null) payload.data = bytesFromJson(payload.data) as Uint8Array;
    for (const [key, item] of Object.entries(payload.metadata ?? {})) {
      if (item != null) payload.metadata![key] = bytesFromJson(item) as Uint8Array;
    }
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) normalizePayloadBytes(item, seen);
}

function bytesFromJson(value: unknown): unknown {
  if (value == null || value instanceof Uint8Array || typeof value !== 'object') return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  const record = value as Record<string, unknown>;
  if (record.type === 'Buffer' && Array.isArray(record.data)) return new Uint8Array(record.data as number[]);
  const entries = Object.entries(record);
  if (entries.every(([key, item]) => /^\d+$/.test(key) && typeof item === 'number')) {
    const bytes = new Uint8Array(entries.length);
    for (const [key, item] of entries) bytes[Number(key)] = item as number;
    return bytes;
  }
  return value;
}
