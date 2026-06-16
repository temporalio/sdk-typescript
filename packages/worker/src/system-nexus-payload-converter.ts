import { defaultPayloadConverter, u8 } from '@temporalio/common';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { decode, encode } from '@temporalio/common/lib/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import { SYSTEM_NEXUS_OPERATIONS, visitSystemNexusPayloads } from './system-nexus-payload-visitor';

function operationDefinition(service: string, operation: string) {
  return SYSTEM_NEXUS_OPERATIONS.find((op) => op.service === service && op.operation === operation);
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

  const messageType = lookupMessageClass(op.inputType);
  const message = messageType.create(defaultPayloadConverter.fromPayload(payload) ?? {});
  normalizePayloadBytes(message);
  await visitSystemNexusPayloads(
    op.inputType,
    message,
    (single) => encode(codecs, [single], context).then(([encoded]) => encoded!),
    (payloads) => encode(codecs, payloads, context)
  );
  return protoBinaryPayload(op.inputType, message);
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

  assertProtoBinaryPayload(payload, op.outputType);
  const messageType = lookupMessageClass(op.outputType);
  const message = messageType.decode(payload.data!);
  await visitSystemNexusPayloads(
    op.outputType,
    message,
    (single) => decode(codecs, [single], context).then(([decoded]) => decoded!),
    (payloads) => decode(codecs, payloads, context)
  );
  return defaultPayloadConverter.toPayload(message)!;
}

function protoBinaryPayload(messageTypeName: string, message: any): Payload {
  const messageType = lookupMessageClass(messageTypeName);
  return {
    metadata: { encoding: u8('binary/protobuf'), messageType: u8(messageTypeName) },
    data: messageType.encode(message).finish(),
  };
}

function assertProtoBinaryPayload(payload: Payload, messageTypeName: string): void {
  if (payload.data == null) throw new Error('System Nexus protobuf payload is missing data');
  const metadata = payload.metadata ?? {};
  if (decodeUtf8(metadata.encoding) !== 'binary/protobuf') {
    throw new Error('System Nexus envelope must use binary/protobuf encoding');
  }
  if (decodeUtf8(metadata.messageType) !== messageTypeName) {
    throw new Error(`System Nexus envelope type mismatch: expected ${messageTypeName}`);
  }
}

function lookupMessageClass(messageTypeName: string): any {
  let current: any = protoRoot;
  for (const part of messageTypeName.split('.')) {
    current = current?.[part];
    if (current == null) throw new Error(`Unknown system Nexus protobuf message type: ${messageTypeName}`);
  }
  return current;
}

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

function decodeUtf8(bytes: Uint8Array | null | undefined): string | undefined {
  return bytes == null ? undefined : new TextDecoder().decode(bytes);
}
