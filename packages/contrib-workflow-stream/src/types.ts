/**
 * Shared data types for the workflow stream contrib module.
 *
 * User-facing `data` fields on {@link WorkflowStreamItem} are Temporal
 * {@link Payload}s so that per-item metadata (encoding, messageType)
 * round-trips to consumers. See README §"Cross-Language Protocol".
 *
 * The wire representation (`PublishEntry`, `_WorkflowStreamWireItem`) uses
 * base64-encoded `Payload` protobuf bytes because the default JSON
 * converter cannot serialize a `Payload` object embedded inside a
 * plain (non-top-level) field. Using a base64 proto bytes string
 * keeps the envelope JSON-serializable while preserving Payload
 * metadata for codec and typed-decode paths.
 *
 * The Payload encoding here is the protobuf binary encoding of the
 * `temporal.api.common.v1.Payload` message — a map<string, bytes>
 * metadata field (tag 1) and a bytes data field (tag 2). Cross-SDK
 * compatibility requires matching exactly.
 */

import type { Payload } from '@temporalio/common';

/**
 * A single item in the workflow stream log (user-facing).
 *
 * Generic on the decoded ``data`` type ``T``. Default ``T = Payload``
 * matches what {@link WorkflowStreamClient.subscribe} yields — the raw
 * payload, with ``metadata.encoding`` available for downstream decode.
 * Subscribing through a {@link TopicHandle} narrows ``T`` to the
 * handle's bound type, with the default payload converter applied per
 * item.
 *
 * The ``offset`` field is populated by the poll handler from the item's
 * position in the global log.
 */
export interface WorkflowStreamItem<T = Payload> {
  topic: string;
  data: T;
  offset: number;
}

/** A single entry to publish via signal (wire type). */
export interface PublishEntry {
  topic: string;
  /** Base64-encoded Payload protobuf bytes. */
  data: string;
}

/**
 * Wire representation of a WorkflowStreamItem (base64 of serialized Payload).
 *
 * The `offset` field is populated by the poll handler from the item's
 * position in the global log. It is unused in the `getState()` snapshot
 * (offsets there are re-derivable from `base_offset + index`).
 */
export interface _WorkflowStreamWireItem {
  topic: string;
  /** Base64-encoded Payload protobuf bytes. */
  data: string;
  offset: number;
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

/**
 * Update response: items matching the poll request (wire type).
 *
 * When `more_ready` is true, the response was truncated to stay within size
 * limits and the subscriber should poll again immediately rather than applying
 * a cooldown delay.
 */
export interface PollResult {
  items: _WorkflowStreamWireItem[];
  next_offset: number;
  more_ready: boolean;
}

/** Serializable snapshot of workflow stream state for continue-as-new. */
export interface WorkflowStreamState {
  log: _WorkflowStreamWireItem[];
  base_offset: number;
  publisher_sequences: Record<string, number>;
  /** Per-publisher last-seen timestamps (seconds) for TTL pruning. */
  publisher_last_seen: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Base64 helpers (no Buffer dependency for workflow sandbox compat)
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode bytes to standard base64 (padded). */
export function encodeBase64(data: Uint8Array): string {
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

/** Decode standard base64 to bytes. */
export function decodeBase64(data: string): Uint8Array {
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

// ---------------------------------------------------------------------------
// Protobuf codec for temporal.api.common.v1.Payload
// ---------------------------------------------------------------------------
//
// Payload schema:
//   message Payload {
//     map<string, bytes> metadata = 1;
//     bytes data = 2;
//   }
//
// Map entries are encoded as embedded messages:
//   message MapEntry { string key = 1; bytes value = 2; }
//
// Wire format is hand-rolled here (rather than reusing `@temporalio/proto`'s
// generated class) to avoid pulling the protobufjs runtime into the workflow
// sandbox. The schema is a fixed public API — the manual encoder cannot
// silently go out of sync with server-side expectations.

function writeVarint(buf: number[], n: number): void {
  while (n >= 0x80) {
    buf.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  buf.push(n & 0x7f);
}

function readVarint(bytes: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  while (true) {
    if (pos.i >= bytes.length) {
      throw new Error('unexpected end of varint');
    }
    const b = bytes[pos.i++]!;
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint too large');
  }
  return result;
}

function writeTagLenBytes(buf: number[], tag: number, bytes: Uint8Array): void {
  buf.push(tag);
  writeVarint(buf, bytes.length);
  for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]!);
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/** Encode a Payload to its protobuf binary representation. */
export function encodePayloadProto(payload: Payload): Uint8Array {
  const buf: number[] = [];
  const metadata = payload.metadata ?? {};
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    if (value == null) continue;
    // Inner: key (tag 0x0A, wire-type 2) + value (tag 0x12, wire-type 2)
    const entry: number[] = [];
    writeTagLenBytes(entry, 0x0a, utf8Encode(key));
    writeTagLenBytes(entry, 0x12, value);
    // Outer: metadata field 1, wire-type 2
    writeTagLenBytes(buf, 0x0a, new Uint8Array(entry));
  }
  const data = payload.data;
  if (data && data.length > 0) {
    writeTagLenBytes(buf, 0x12, data);
  }
  return new Uint8Array(buf);
}

/** Decode protobuf binary bytes to a Payload. */
export function decodePayloadProto(bytes: Uint8Array): Payload {
  const pos = { i: 0 };
  const metadata: Record<string, Uint8Array> = {};
  let data: Uint8Array = new Uint8Array(0);
  while (pos.i < bytes.length) {
    const tag = bytes[pos.i++]!;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      const len = readVarint(bytes, pos);
      const chunk = bytes.subarray(pos.i, pos.i + len);
      pos.i += len;
      if (fieldNumber === 1) {
        // Parse inner map entry message
        const p2 = { i: 0 };
        let key = '';
        let value = new Uint8Array(0);
        while (p2.i < chunk.length) {
          const itag = chunk[p2.i++]!;
          const ifn = itag >>> 3;
          const iwt = itag & 0x07;
          if (iwt !== 2) {
            // skip — only length-delim fields are expected here
            const skipLen = readVarint(chunk, p2);
            p2.i += skipLen;
            continue;
          }
          const ilen = readVarint(chunk, p2);
          const ival = chunk.subarray(p2.i, p2.i + ilen);
          p2.i += ilen;
          if (ifn === 1) key = utf8Decode(ival);
          else if (ifn === 2) value = new Uint8Array(ival);
        }
        metadata[key] = value;
      } else if (fieldNumber === 2) {
        data = new Uint8Array(chunk);
      }
      // Other fields (e.g. externalPayloads = 3) are ignored.
    } else if (wireType === 0) {
      readVarint(bytes, pos);
    } else if (wireType === 1) {
      pos.i += 8;
    } else if (wireType === 5) {
      pos.i += 4;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  return { metadata, data };
}

/** Convenience: encode a Payload to the base64 wire format used by stream. */
export function encodePayloadWire(payload: Payload): string {
  return encodeBase64(encodePayloadProto(payload));
}

/** Convenience: decode the base64 wire format to a Payload. */
export function decodePayloadWire(wire: string): Payload {
  return decodePayloadProto(decodeBase64(wire));
}
