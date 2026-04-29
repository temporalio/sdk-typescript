/**
 * Workflow Streams for Temporal workflows.
 *
 * This module gives a workflow a durable, offset-addressed event channel built
 * from Signals and polling Updates. The workflow holds an append-only log of
 * `(topic, data)` entries. External clients (activities, starters, other
 * services) publish and subscribe through the workflow handle.
 *
 * Payloads are Temporal `Payload`s carrying the encoding metadata needed for
 * typed decode and cross-language interop. The codec chain (encryption,
 * PII-redaction, compression) runs once on the signal/update envelope that
 * carries each batch — not per item.
 *
 * @module
 */

export type {
  WorkflowStreamItem,
  PublishEntry,
  PublishInput,
  PollInput,
  PollResult,
  WorkflowStreamState,
} from './types';
export {
  encodeBase64,
  decodeBase64,
  encodePayloadProto,
  decodePayloadProto,
  encodePayloadWire,
  decodePayloadWire,
} from './types';
export { WorkflowStream, workflowStreamPublishSignal, workflowStreamPollUpdate, workflowStreamOffsetQuery } from './stream';
export { WorkflowStreamClient, FlushTimeoutError } from './client';
export type { WorkflowStreamClientOptions, SubscribeOptions } from './client';
