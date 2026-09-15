/** Internal wire marker carried by System Nexus operation envelopes. */
export const SYSTEM_NEXUS_PAYLOAD_METADATA_KEY = '__temporal_system_payload';
export const SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE = new Uint8Array([116, 114, 117, 101]); // "true"
export const SYSTEM_NEXUS_CONTEXT_METADATA_KEY = '__temporal_system_context';

const SYSTEM_NEXUS_BYTES_KEY = '__temporal_system_bytes';

/** Replaces byte arrays with an unambiguous JSON representation for a System Nexus envelope. */
export function encodeSystemNexusEnvelopeBytes(value: unknown): unknown {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) {
      return { [SYSTEM_NEXUS_BYTES_KEY]: Array.from(item) };
    }
    return item;
  });
  return json === undefined ? undefined : JSON.parse(json);
}

/** Restores byte arrays encoded by {@link encodeSystemNexusEnvelopeBytes}. */
export function decodeSystemNexusEnvelopeBytes(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeSystemNexusEnvelopeBytes);
  const record = value as Record<string, unknown>;
  const bytes = record[SYSTEM_NEXUS_BYTES_KEY];
  if (Object.keys(record).length === 1 && Array.isArray(bytes)) {
    if (bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return Uint8Array.from(bytes);
    }
    throw new TypeError('invalid System Nexus byte representation');
  }
  for (const [key, item] of Object.entries(record)) {
    record[key] = decodeSystemNexusEnvelopeBytes(item);
  }
  return record;
}
export const TEMPORAL_SYSTEM_NEXUS_ENDPOINT = '__temporal_system';
