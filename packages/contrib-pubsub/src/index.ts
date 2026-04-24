/**
 * Pub/sub support for Temporal workflows.
 *
 * This module provides a reusable pub/sub pattern where a workflow acts as a
 * message broker. External clients (activities, starters, other services)
 * publish and subscribe through the workflow handle using Temporal primitives.
 *
 * Payloads are Temporal `Payload`s carrying the encoding metadata needed for
 * typed decode and cross-language interop. The codec chain (encryption,
 * PII-redaction, compression) runs once on the signal/update envelope that
 * carries each batch — not per item.
 *
 * @module
 */

export type {
  PubSubItem,
  PublishEntry,
  PublishInput,
  PollInput,
  PollResult,
  PubSubState,
} from './types';
export {
  encodeBase64,
  decodeBase64,
  encodePayloadProto,
  decodePayloadProto,
  encodePayloadWire,
  decodePayloadWire,
} from './types';
export { initPubSub, pubsubPublishSignal, pubsubPollUpdate, pubsubOffsetQuery } from './mixin';
export type { PubSubHandle } from './mixin';
export { PubSubClient, FlushTimeoutError } from './client';
export type { PubSubClientOptions, SubscribeOptions } from './client';
