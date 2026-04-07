/**
 * Pub/sub support for Temporal workflows.
 *
 * This module provides a reusable pub/sub pattern where a workflow acts as a
 * message broker. External clients (activities, starters, other services)
 * publish and subscribe through the workflow handle using Temporal primitives.
 *
 * Payloads are opaque byte strings for cross-language compatibility.
 *
 * @module
 */

export type { PubSubItem, PublishEntry, PublishInput, PollInput, PollResult, PubSubState } from './types';
export { toWireBytes, fromWireBytes } from './types';
export { initPubSub, pubsubPublishSignal, pubsubPollUpdate, pubsubOffsetQuery } from './mixin';
export type { PubSubHandle } from './mixin';
export { PubSubClient } from './client';
export type { PubSubClientOptions } from './client';
