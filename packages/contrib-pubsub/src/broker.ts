/**
 * Workflow-side pub/sub broker.
 *
 * Instantiate `PubSub` once at the start of your workflow function; the
 * constructor registers the pub/sub signal, update, and query handlers on
 * the current workflow via `setHandler`.
 *
 * For workflows that support continue-as-new, include a
 * `PubSubState | undefined` field on the workflow input and pass it as
 * `priorState` — it is `undefined` on fresh starts and carries
 * accumulated state on continue-as-new.
 *
 * Both workflow-side `PubSub.publish` and client-side
 * `PubSubClient.publish` use the default payload converter for per-item
 * `Payload` construction. The codec chain (encryption, PII-redaction,
 * compression) is NOT applied per item on either side — it runs once at
 * the envelope level when Temporal's SDK encodes the signal/update that
 * carries the batch.
 */

import {
  allHandlersFinished,
  condition,
  continueAsNew as workflowContinueAsNew,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  defaultPayloadConverter,
} from '@temporalio/workflow';
import { ApplicationFailure, type Payload, type Workflow } from '@temporalio/common';
import { Duration, msToNumber } from '@temporalio/common/lib/time';
import {
  decodePayloadWire,
  encodePayloadProto,
  encodePayloadWire,
  encodeBase64,
  type PollInput,
  type PollResult,
  type PubSubState,
  type PublishInput,
  type _WireItem,
} from './types';

const BINARY_PLAIN_ENCODING = new TextEncoder().encode('binary/plain');

/**
 * Cross-realm-safe Uint8Array check.
 *
 * The workflow sandbox gets its `TextEncoder` from `node:util`, which
 * returns a `Uint8Array` tagged to the host realm — so `value instanceof
 * Uint8Array` is false against the sandbox's own `Uint8Array` global.
 * `Object.prototype.toString` crosses realm boundaries reliably.
 */
function isUint8ArrayLike(value: unknown): value is ArrayLike<number> {
  return (
    value != null &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

// Fixed handler names for cross-language interop
export const pubsubPublishSignal = defineSignal<[PublishInput]>('__temporal_pubsub_publish');
export const pubsubPollUpdate = defineUpdate<PollResult, [PollInput]>('__temporal_pubsub_poll');
export const pubsubOffsetQuery = defineQuery<number>('__temporal_pubsub_offset');

const MAX_POLL_RESPONSE_BYTES = 1_000_000;

/** Approximate poll-response contribution of a single encoded payload. */
function payloadWireSize(encoded: string, topic: string): number {
  // `encoded` is already base64 (the on-wire representation).
  return encoded.length + topic.length;
}

/** Internal log entry: stores decoded Payload for user-facing APIs. */
interface InternalLogEntry {
  topic: string;
  payload: Payload;
}

/** Type guard for Payload — same logic as client.ts's isPayload. */
function isPayload(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { metadata?: unknown };
  return (
    'metadata' in v &&
    v.metadata != null &&
    typeof v.metadata === 'object' &&
    !Array.isArray(v.metadata) &&
    Object.values(v.metadata).every((x) => x instanceof Uint8Array)
  );
}

/**
 * Workflow-side pub/sub broker.
 *
 * Construct once at the start of your workflow function; the constructor
 * registers the pub/sub signal, update, and query handlers on the current
 * workflow.
 *
 * Registered handlers:
 *
 * - `__temporal_pubsub_publish` signal — external publish with dedup
 * - `__temporal_pubsub_poll` update — long-poll subscription
 * - `__temporal_pubsub_offset` query — current log length
 *
 * For continue-as-new, thread a `PubSubState | undefined` field through
 * the workflow input and pass it as `priorState`.
 */
export class PubSub {
  private log: InternalLogEntry[];
  private baseOffset: number;
  private readonly publisherSequences: Record<string, number>;
  private readonly publisherLastSeen: Record<string, number>;
  private draining = false;

  constructor(priorState?: PubSubState) {
    // Note: sdk-python guards against a second `PubSub(...)` call on the
    // same workflow by checking `workflow.get_signal_handler(...)`. The
    // TypeScript workflow runtime does not expose that inspection API,
    // and `reuseV8Context` shares module-level state across workflow
    // executions — so a naive module-level flag would either fire
    // spuriously or miss real duplicates. Constructing `PubSub` twice in
    // the same workflow silently replaces the handlers; users should
    // construct once at the top of the workflow function.
    this.log = priorState?.log
      ? priorState.log.map((item) => ({
          topic: item.topic,
          payload: decodePayloadWire(item.data),
        }))
      : [];
    this.baseOffset = priorState?.base_offset ?? 0;
    this.publisherSequences = priorState?.publisher_sequences
      ? { ...priorState.publisher_sequences }
      : {};
    this.publisherLastSeen = priorState?.publisher_last_seen
      ? { ...priorState.publisher_last_seen }
      : {};

    setHandler(pubsubPublishSignal, (input: PublishInput) => this.onPublish(input));
    setHandler(pubsubPollUpdate, (input: PollInput) => this.onPoll(input), {
      validator: (_input: PollInput) => {
        if (this.draining) {
          throw new Error('Workflow is draining for continue-as-new');
        }
      },
    });
    setHandler(pubsubOffsetQuery, () => this.baseOffset + this.log.length);
  }

  /**
   * Publish an item from within workflow code. Deterministic — just appends.
   * `value` may be any value the default payload converter can handle, or
   * a pre-built `Payload` for zero-copy.
   */
  publish(topic: string, value: unknown): void {
    let payload: Payload;
    if (isPayload(value)) {
      payload = value;
    } else if (isUint8ArrayLike(value)) {
      // Bypass defaultPayloadConverter for cross-realm Uint8Arrays: the
      // BinaryPayloadConverter uses `instanceof Uint8Array`, which fails
      // against a Uint8Array produced by Node's built-in `TextEncoder`
      // (host realm) when evaluated in the workflow sandbox. Construct
      // the equivalent binary/plain Payload directly.
      payload = {
        metadata: { encoding: BINARY_PLAIN_ENCODING },
        data: new Uint8Array(value),
      };
    } else {
      payload = defaultPayloadConverter.toPayload(value);
    }
    this.log.push({ topic, payload });
  }

  /** Unblock all waiting poll handlers and reject new polls for CAN. */
  drain(): void {
    this.draining = true;
  }

  /**
   * Return a serializable snapshot of pub/sub state for continue-as-new.
   * Prunes publisher dedup entries older than `publisherTtl`. Defaults
   * to 15 minutes.
   */
  getState(publisherTtl: Duration = '15 minutes'): PubSubState {
    const ttlSeconds = msToNumber(publisherTtl) / 1000;
    const now = Date.now() / 1000;
    const activeSeqs: Record<string, number> = {};
    const activeSeen: Record<string, number> = {};
    for (const pid of Object.keys(this.publisherSequences)) {
      // Missing timestamps are pruned (matches sdk-python). The signal
      // handler always sets both maps together, so absence indicates a
      // malformed snapshot rather than a supported upgrade path.
      const ts = this.publisherLastSeen[pid] ?? 0;
      if (now - ts < ttlSeconds) {
        activeSeqs[pid] = this.publisherSequences[pid] ?? 0;
        activeSeen[pid] = ts;
      }
    }
    return {
      // Per-item offset is re-derivable from base_offset + index on reload,
      // so we leave it at 0 here.
      log: this.log.map((entry) => ({
        topic: entry.topic,
        data: encodePayloadWire(entry.payload),
        offset: 0,
      })),
      base_offset: this.baseOffset,
      publisher_sequences: activeSeqs,
      publisher_last_seen: activeSeen,
    };
  }

  /**
   * Drain, wait for in-flight handlers, then `continueAsNew` with built args.
   *
   * Replaces the recipe `drain()` → `condition(allHandlersFinished)` →
   * `continueAsNew(...)` for the common case where the only thing that
   * varies across CAN boundaries is the workflow's own arguments.
   *
   * `buildArgs` is invoked *after* drain stabilizes, with the post-drain
   * `PubSubState` as its single argument, and must return the positional
   * argument tuple for the new run.
   *
   * @example
   * ```typescript
   * await pubsub.continueAsNew<typeof myWorkflow>((state) => [{
   *   itemsProcessed,
   *   pubsubState: state,
   * }]);
   * ```
   *
   * @param buildArgs Receives the post-drain pub/sub state and returns the
   *   positional args for the new run.
   * @param options.publisherTtl Forwarded to `getState`.
   *
   * Does not return; `continueAsNew` rejects with an internal exception
   * that the SDK uses to close the run.
   */
  async continueAsNew<F extends Workflow>(
    buildArgs: (state: PubSubState) => Parameters<F>,
    options?: { publisherTtl?: Duration },
  ): Promise<never> {
    this.drain();
    await condition(allHandlersFinished);
    return workflowContinueAsNew<F>(...buildArgs(this.getState(options?.publisherTtl)));
  }

  /**
   * Discard log entries before upToOffset.
   * After truncation, polls requesting an offset before the new base
   * will receive an error.
   *
   * Raises `ApplicationFailure` with type `'TruncateOutOfRange'` and
   * `nonRetryable: true` when the requested offset is past the end of
   * the log. Mirrors how `onPoll` reports `'TruncatedOffset'`: an update
   * handler invoking `truncate` surfaces the error to the caller without
   * failing the workflow task.
   */
  truncate(upToOffset: number): void {
    const logIndex = upToOffset - this.baseOffset;
    if (logIndex <= 0) return;
    if (logIndex > this.log.length) {
      throw ApplicationFailure.create({
        message:
          `Cannot truncate to offset ${upToOffset}: only ${this.baseOffset + this.log.length} items exist`,
        type: 'TruncateOutOfRange',
        nonRetryable: true,
      });
    }
    this.log.splice(0, logIndex);
    this.baseOffset = upToOffset;
  }

  private onPublish(input: PublishInput): void {
    if (input.publisher_id) {
      const lastSeq = this.publisherSequences[input.publisher_id] ?? 0;
      if (input.sequence <= lastSeq) {
        return; // duplicate — skip
      }
      this.publisherSequences[input.publisher_id] = input.sequence;
      this.publisherLastSeen[input.publisher_id] = Date.now() / 1000; // seconds
    }
    for (const entry of input.items) {
      this.log.push({ topic: entry.topic, payload: decodePayloadWire(entry.data) });
    }
  }

  private async onPoll(input: PollInput): Promise<PollResult> {
    let logOffset = input.from_offset - this.baseOffset;
    if (logOffset < 0) {
      if (input.from_offset === 0) {
        // "From the beginning" — start at whatever is available.
        logOffset = 0;
      } else {
        // Subscriber had a specific position that's been truncated.
        // ApplicationFailure fails this update (client gets the error)
        // without crashing the workflow task — avoids a poison pill
        // during replay.
        throw ApplicationFailure.create({
          message:
            `Requested offset ${input.from_offset} has been truncated. ` +
            `Current base offset is ${this.baseOffset}.`,
          type: 'TruncatedOffset',
          nonRetryable: true,
        });
      }
    }
    await condition(() => this.log.length > logOffset || this.draining);
    const allNew = this.log.slice(logOffset);

    // Build [globalOffset, entry] candidates, filtering by topic if requested.
    const topicSet = input.topics.length > 0 ? new Set(input.topics) : null;
    const candidates: Array<[number, InternalLogEntry]> = [];
    for (let i = 0; i < allNew.length; i++) {
      const entry = allNew[i]!;
      if (topicSet !== null && !topicSet.has(entry.topic)) continue;
      candidates.push([this.baseOffset + logOffset + i, entry]);
    }

    // Cap response size to ~1MB of estimated wire bytes.
    const wireItems: _WireItem[] = [];
    let size = 0;
    let moreReady = false;
    let nextOffset = this.baseOffset + this.log.length;
    for (const [off, entry] of candidates) {
      const encoded = encodeBase64(encodePayloadProto(entry.payload));
      const itemSize = payloadWireSize(encoded, entry.topic);
      if (size + itemSize > MAX_POLL_RESPONSE_BYTES && wireItems.length > 0) {
        // Resume from this item on the next poll.
        nextOffset = off;
        moreReady = true;
        break;
      }
      size += itemSize;
      wireItems.push({ topic: entry.topic, data: encoded, offset: off });
    }

    return {
      items: wireItems,
      next_offset: nextOffset,
      more_ready: moreReady,
    };
  }
}
