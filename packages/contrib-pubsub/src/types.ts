/**
 * Shared data types for the pub/sub contrib module.
 *
 * These types are serialized as JSON through Temporal's default data converter
 * and must match the Python dataclass wire format for cross-language interop.
 *
 * IMPORTANT: Python's default JSON converter serializes `bytes` fields as
 * numeric arrays (e.g., [104, 101, 108, 108, 111]), NOT base64 strings.
 * The `data` field uses `number[]` to match this wire format.
 */

/** A single item in the pub/sub log. */
export interface PubSubItem {
  topic: string;
  /** Opaque payload. Wire format: JSON numeric array matching Python bytes. */
  data: number[];
}

/** A single entry to publish (used in batch signals). */
export interface PublishEntry {
  topic: string;
  /** Opaque payload. Wire format: JSON numeric array matching Python bytes. */
  data: number[];
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
  timeout: number;
}

/** Update response: items matching the poll request. */
export interface PollResult {
  items: PubSubItem[];
  next_offset: number;
}

/** Serializable snapshot of pub/sub state for continue-as-new. */
export interface PubSubState {
  log: PubSubItem[];
  base_offset: number;
  publisher_sequences: Record<string, number>;
}

/** Convert a string to wire format (number[] matching Python bytes). */
export function toWireBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/** Convert wire format (number[] from Python bytes) to a string. */
export function fromWireBytes(data: number[]): string {
  return new TextDecoder().decode(new Uint8Array(data));
}
