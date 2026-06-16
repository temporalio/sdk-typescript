import type { Payload, PayloadCodec, PayloadConverter, SerializationContext } from '@temporalio/common';
import { decode, encode } from '@temporalio/common/lib/encoding';

const ENCODING = 'json/system-nexus-test';

export interface SystemNexusTestTrace<T = string> {
  label: T;
  trace: string[];
}

export function makeSystemNexusTestTrace<T>(label: T): SystemNexusTestTrace<T> {
  return { label, trace: [] };
}

function isTrace(value: unknown): value is SystemNexusTestTrace {
  return (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    'trace' in value &&
    Array.isArray((value as SystemNexusTestTrace).trace)
  );
}

function encoding(payload: Payload): string | undefined {
  const encoded = payload.metadata?.encoding;
  return encoded == null ? undefined : decode(encoded);
}

function jsonData(payload: Payload): unknown {
  if (payload.data == null) {
    throw new Error('Expected payload data');
  }
  return JSON.parse(decode(payload.data));
}

function encodedJsonPayload(value: unknown): Payload {
  return {
    metadata: { encoding: encode(ENCODING) },
    data: encode(JSON.stringify({ value })),
  };
}

export class SystemNexusTestPayloadConverter implements PayloadConverter {
  toPayload<T>(value: T, _context?: SerializationContext): Payload {
    if (isTrace(value)) {
      value.trace.push(`payload.encode|${String(value.label)}`);
    }
    return encodedJsonPayload(value);
  }

  fromPayload<T>(payload: Payload, _context?: SerializationContext): T {
    const payloadEncoding = encoding(payload);
    if (payloadEncoding !== ENCODING) {
      throw new Error(`Unexpected payload encoding: ${payloadEncoding ?? '<missing>'}`);
    }
    const wrapper = jsonData(payload) as { value: T };
    if (isTrace(wrapper.value)) {
      wrapper.value.trace.push(`payload.decode|${String(wrapper.value.label)}`);
    }
    return wrapper.value;
  }
}

export const payloadConverter = new SystemNexusTestPayloadConverter();

export class SystemNexusTestPayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => visitPayload(payload, 'codec.encode'));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => visitPayload(payload, 'codec.decode'));
  }
}

function visitPayload(payload: Payload, operation: 'codec.encode' | 'codec.decode'): Payload {
  assertNotSystemNexusEnvelope(payload);
  if (encoding(payload) !== ENCODING) {
    return payload;
  }

  const wrapper = jsonData(payload) as { value: unknown };
  if (isTrace(wrapper.value)) {
    wrapper.value.trace.push(`${operation}|${String(wrapper.value.label)}`);
  }
  return { ...payload, data: encode(JSON.stringify(wrapper)) };
}

function assertNotSystemNexusEnvelope(payload: Payload): void {
  const messageType = payload.metadata?.messageType == null ? undefined : decode(payload.metadata.messageType);
  if (messageType?.includes('SignalWithStartWorkflowExecution')) {
    throw new Error(`Codec was applied to system Nexus protobuf envelope: ${messageType}`);
  }

  if (encoding(payload) !== 'json/plain') {
    return;
  }

  const maybeEnvelope = jsonData(payload);
  if (
    typeof maybeEnvelope === 'object' &&
    maybeEnvelope !== null &&
    'workflowId' in maybeEnvelope &&
    'signalName' in maybeEnvelope
  ) {
    throw new Error('Codec was applied to system Nexus JSON envelope');
  }
}
