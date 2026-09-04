import type { Type as ProtobufType } from 'protobufjs';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import { decode, encode, visit } from '@temporalio/common/lib/internal-non-workflow';
import * as payloadVisitors from '@temporalio/common/lib/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import { operationRegistry } from '@temporalio/workflow/lib/nexus/system/generated/services';

const protobufPayloadConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const protoRootWithLookup = protoRoot as typeof protoRoot & { lookupType(name: string): ProtobufType };
export const TEMPORAL_SYSTEM_NEXUS_ENDPOINT = '__temporal_system';
const SYSTEM_NEXUS_PAYLOAD_METADATA_KEY = '__temporal_system_payload';
const SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE = new Uint8Array([116, 114, 117, 101]); // "true"

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

function payloadVisitor(name: string): unknown {
  return (payloadVisitors as Record<string, unknown>)[name];
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
  const properties = defaultPayloadConverter.fromPayload(payload) as Record<string, unknown>;
  const message = protoRootWithLookup.lookupType(definition.inputType).create(properties) as Record<string, unknown>;
  normalizePayloadBytes(message);
  const context = definition.serializationContext?.(message) ?? workflowContext;
  const visitor = payloadVisitor(definition.inputPayloadVisitor);
  if (visitor != null) {
    await visit(message, visitor as never, {
      initialContext: context,
      transformPayload: async (value, valueContext) => (await encode(codecs, [value], valueContext))[0]!,
      transformPayloads: (values, valueContext) => encode(codecs, values, valueContext),
      skipSearchAttributes: true,
    });
  }
  const encoded = protobufPayloadConverter.toPayload(message);
  if (encoded == null) throw new Error('failed to encode System Nexus protobuf envelope');
  return { payload: encoded, context };
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
  if (definition == null || payload == null) return undefined;
  const message = protobufPayloadConverter.fromPayload<Record<string, unknown>>(payload);
  const visitor = payloadVisitor(definition.outputPayloadVisitor);
  if (visitor != null) {
    await visit(message, visitor as never, {
      initialContext: context,
      transformPayload: async (value, valueContext) => (await decode(codecs, [value], valueContext))[0]!,
      transformPayloads: (values, valueContext) => decode(codecs, values, valueContext),
      skipSearchAttributes: true,
    });
  }
  return defaultPayloadConverter.toPayload(message) ?? undefined;
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
