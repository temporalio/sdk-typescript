/**
 * Shared data types for the pub/sub contrib module.
 *
 * These types are serialized as JSON through Temporal's default data converter
 * and must match the wire format across all SDK languages.
 *
 * Wire types (PublishEntry, _WireItem, PollResult) use base64 strings for the
 * data field. User-facing types (PubSubItem) use Uint8Array.
 */

/** A single item in the pub/sub log (user-facing). */
export interface PubSubItem {
  topic: string;
  /** Opaque byte payload. */
  data: Uint8Array;
}

/** A single entry to publish via signal (wire type). */
export interface PublishEntry {
  topic: string;
  /** Base64-encoded byte payload. */
  data: string;
}

/** Wire representation of a PubSubItem (base64 data). */
export interface _WireItem {
  topic: string;
  /** Base64-encoded byte payload. */
  data: string;
}

/** Signal payload: batch of entries to publish with dedup fields. */
export interface PublishInput {
  items: PublishEntry[];
  publisher_id: string;
  sequence: number;
}

/** Update payload: request to poll for new items. */
export interface PollInput {
  topics: string[];
  from_offset: number;
}

/** Update response: items matching the poll request (wire type). */
export interface PollResult {
  items: _WireItem[];
  next_offset: number;
}

/** Serializable snapshot of pub/sub state for continue-as-new. */
export interface PubSubState {
  log: _WireItem[];
  base_offset: number;
  publisher_sequences: Record<string, number>;
  /** Per-publisher last-seen timestamps for TTL pruning. */
  publisher_last_seen?: Record<string, number>;
}

// --- Base64 helpers (no Buffer dependency for workflow sandbox compat) ---

// Standard base64 alphabet
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode bytes to base64 string for wire format. */
export function encodeData(data: Uint8Array): string {
  let result = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i]!;
    const b1 = i + 1 < data.length ? data[i + 1]! : 0;
    const b2 = i + 2 < data.length ? data[i + 2]! : 0;
    result += B64[(b0 >> 2) & 0x3f];
    result += B64[((b0 << 4) | (b1 >> 4)) & 0x3f];
    result += i + 1 < data.length ? B64[((b1 << 2) | (b2 >> 6)) & 0x3f] : '=';
    result += i + 2 < data.length ? B64[b2 & 0x3f] : '=';
  }
  return result;
}

/** Decode base64 string from wire format to bytes. */
export function decodeData(data: string): Uint8Array {
  const clean = data.replace(/=+$/, '');
  const len = (clean.length * 3) >> 2;
  const out = new Uint8Array(len);
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean.charAt(i));
    const b = i + 1 < clean.length ? B64.indexOf(clean.charAt(i + 1)) : 0;
    const c = i + 2 < clean.length ? B64.indexOf(clean.charAt(i + 2)) : 0;
    const d = i + 3 < clean.length ? B64.indexOf(clean.charAt(i + 3)) : 0;
    out[j++] = (a << 2) | (b >> 4);
    if (j < len) out[j++] = ((b << 4) | (c >> 2)) & 0xff;
    if (j < len) out[j++] = ((c << 6) | d) & 0xff;
  }
  return out;
}

/**
 * Encode a UTF-8 string to base64 wire format.
 *
 * Convenience wrapper: encodes the string as UTF-8 bytes, then base64.
 */
export function toWireBytes(s: string): string {
  return encodeData(new TextEncoder().encode(s));
}

/**
 * Decode a base64 wire format string back to a UTF-8 string.
 *
 * Convenience wrapper: decodes base64 to bytes, then interprets as UTF-8.
 */
export function fromWireBytes(data: string): string {
  return new TextDecoder().decode(decodeData(data));
}
