/**
 * Shared data types for the workflow stream contrib module.
 *
 * User-facing `data` fields on {@link WorkflowStreamItem} are Temporal
 * {@link Payload}s so that per-item metadata (encoding, messageType)
 * round-trips to consumers. See README §"Cross-Language Protocol".
 *
 * The wire representation (`PublishEntry`, `WorkflowStreamWireItem`) uses
 * base64-encoded `Payload` protobuf bytes because the default JSON
 * converter cannot serialize a `Payload` object embedded inside a
 * plain (non-top-level) field. Using a base64 proto bytes string
 * keeps the envelope JSON-serializable while preserving Payload
 * metadata for codec and typed-decode paths. See `./codec` for the
 * encoder/decoder.
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
export interface WorkflowStreamWireItem {
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
  items: WorkflowStreamWireItem[];
  next_offset: number;
  more_ready: boolean;
}

/** Serializable snapshot of workflow stream state for continue-as-new. */
export interface WorkflowStreamState {
  log: WorkflowStreamWireItem[];
  base_offset: number;
  publisher_sequences: Record<string, number>;
  /** Per-publisher last-seen timestamps (seconds) for TTL pruning. */
  publisher_last_seen: Record<string, number>;
}
