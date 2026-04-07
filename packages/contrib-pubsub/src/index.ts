/**
 * Pub/sub support for Temporal workflows.
 *
 * This module provides a reusable pub/sub pattern where a workflow acts as a
 * message broker. External clients (activities, starters, other services)
 * publish and subscribe through the workflow handle using Temporal primitives.
 *
 * Payloads are opaque bytes. Base64 encoding is used on the wire for
 * cross-language compatibility, but users work with native Uint8Array.
 *
 * @module
 */

export type { PubSubItem, PublishEntry, PublishInput, PollInput, PollResult, PubSubState } from './types';
export { toWireBytes, fromWireBytes, encodeData, decodeData } from './types';
export { initPubSub, pubsubPublishSignal, pubsubPollUpdate, pubsubOffsetQuery } from './mixin';
export type { PubSubHandle } from './mixin';
export { PubSubClient, FlushTimeoutError } from './client';
export type { PubSubClientOptions } from './client';
