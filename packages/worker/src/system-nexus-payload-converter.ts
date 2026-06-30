import { defaultPayloadConverter } from '@temporalio/common';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import { decode, encode } from '@temporalio/common/lib/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import type { Type as ProtobufType } from 'protobufjs';
import { operationRegistry } from '@temporalio/workflow/lib/nexus/system/generated/service';
import { visitSystemNexusPayloads } from './system-nexus-payload-visitor';
import type { SystemNexusMessage, SystemNexusMessageByType } from './system-nexus-payload-visitor';

const protobufPayloadConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const protoRootWithLookup = protoRoot as typeof protoRoot & { lookupType(messageTypeName: string): ProtobufType };

function operationDefinition(service: string, operation: string) {
  return operationRegistry.find((op) => op.service === service && op.operation === operation);
}

export function isSystemNexusOperation(
  service: string | null | undefined,
  operation: string | null | undefined
): boolean {
  return service != null && operation != null && operationDefinition(service, operation) != null;
}

export async function tryConvertSystemNexusInputJsonToProtoBinaryPayload(
  codecs: PayloadCodec[],
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined,
  context: SerializationContext
): Promise<Payload | undefined> {
  if (service == null || operation == null || payload == null) return undefined;
  const op = operationDefinition(service, operation);
  if (op == null) return undefined;

  const message = createSystemNexusMessage(op.inputType, payloadProperties(payload));
  // The workflow side serializes the system Nexus envelope as json/plain, but fields inside that envelope may be
  // Temporal Payloads with Uint8Array data and metadata values. JSON round-tripping turns those bytes into plain JS
  // objects/arrays, so restore them before protobuf binary encoding.
  normalizePayloadBytes(message);
  await visitSystemNexusPayloads(
    message,
    (single) => encode(codecs, [single], context).then(([encoded]) => encoded!),
    (payloads) => encode(codecs, payloads, context)
  );
  const protoPayload = protobufPayloadConverter.toPayload(message);
  if (protoPayload == null) {
    throw new Error('Failed to serialize system Nexus protobuf message');
  }
  return protoPayload;
}

export async function tryConvertSystemNexusOutputProtoBinaryToJsonPayload(
  codecs: PayloadCodec[],
  service: string | null | undefined,
  operation: string | null | undefined,
  payload: Payload | null | undefined,
  context: SerializationContext
): Promise<Payload | undefined> {
  if (service == null || operation == null || payload == null) return undefined;
  const op = operationDefinition(service, operation);
  if (op == null) return undefined;

  const message = protobufPayloadConverter.fromPayload<SystemNexusMessage>(payload);
  await visitSystemNexusPayloads(
    message,
    (single) => decode(codecs, [single], context).then(([decoded]) => decoded!),
    (payloads) => decode(codecs, payloads, context)
  );
  return defaultPayloadConverter.toPayload(message)!;
}

function createSystemNexusMessage<T extends keyof SystemNexusMessageByType>(
  messageTypeName: T,
  properties: Record<string, unknown>
): SystemNexusMessageByType[T] {
  return protoRootWithLookup.lookupType(messageTypeName).create(properties) as unknown as SystemNexusMessageByType[T];
}

function payloadProperties(payload: Payload): Record<string, unknown> {
  const value = defaultPayloadConverter.fromPayload(payload);
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Normalize nested Payload byte fields after json/plain envelope decoding. Protobufjs expects bytes fields to be
// Uint8Array-compatible when encoding the system Nexus request to binary/protobuf.
function normalizePayloadBytes(value: unknown, seen = new Set<object>()): void {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (isPayloadLike(value)) {
    if (value.data != null) value.data = bytesFromJson(value.data) as Uint8Array;
    for (const [key, metadataValue] of Object.entries(value.metadata ?? {})) {
      if (metadataValue != null) value.metadata![key] = bytesFromJson(metadataValue) as Uint8Array;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) normalizePayloadBytes(item, seen);
  } else {
    for (const item of Object.values(value)) normalizePayloadBytes(item, seen);
  }
}

function isPayloadLike(value: object): value is Payload {
  return 'metadata' in value && ('data' in value || (value as Payload).data == null);
}

function bytesFromJson(value: unknown): Uint8Array | unknown {
  if (value == null || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value !== 'object') return value;
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
