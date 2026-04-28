/**
 * External-side pub/sub client.
 *
 * Used by activities, starters, and any code with a workflow handle to publish
 * messages and subscribe to topics on a pub/sub workflow.
 *
 * Each published value is turned into a `Payload` via the client's payload
 * converter. The codec chain (encryption, PII-redaction, compression) is
 * NOT run per item — it runs once on the signal/update envelope that
 * carries each batch. Running the codec per item would double-encrypt
 * because the envelope path already covers the items. The per-item
 * `Payload` still carries encoding metadata so consumers can decode
 * with a payload converter.
 */

import { randomUUID } from 'crypto';
import { Context as ActivityContext } from '@temporalio/activity';
import {
  Client,
  WorkflowHandle,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
} from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter, type Payload, type PayloadConverter } from '@temporalio/common';
import { Duration, msToNumber } from '@temporalio/common/lib/time';
import {
  decodePayloadWire,
  encodePayloadWire,
  type PollInput,
  type PollResult,
  type PubSubItem,
  type PublishEntry,
  type PublishInput,
} from './types';

/** Thrown when a flush retry exceeds maxRetryDuration. */
export class FlushTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlushTimeoutError';
  }
}

export interface PubSubClientOptions {
  /** Interval between automatic flushes. Default: 2 seconds. */
  batchInterval?: Duration;
  /** Auto-flush when buffer reaches this size. */
  maxBatchSize?: number;
  /**
   * Maximum time to retry a failed flush before throwing. Must be less
   * than the workflow's `publisherTtl` (default 15 minutes) to preserve
   * exactly-once delivery. Default: 10 minutes.
   */
  maxRetryDuration?: Duration;
}

export interface SubscribeOptions {
  /**
   * Minimum interval between polls to avoid overwhelming the workflow
   * when items arrive faster than the poll round-trip. Default: 100ms.
   */
  pollCooldown?: Duration;
}

/**
 * A resolvable event: multiple callers `await wait()` for the same promise,
 * `set()` resolves it once, and `clear()` re-arms it for the next cycle.
 */
class ResolvableEvent {
  private resolver: (() => void) | null = null;
  private promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
  }

  wait(): Promise<void> {
    return this.promise;
  }

  set(): void {
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r();
    }
  }

  clear(): void {
    if (this.resolver !== null) return; // already armed
    this.promise = new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Type guard for a Payload (as opposed to an arbitrary user value). */
function isPayload(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { metadata?: unknown; data?: unknown };
  // Metadata must exist (at minimum with an encoding key) to be a Payload.
  return (
    'metadata' in v &&
    v.metadata != null &&
    typeof v.metadata === 'object' &&
    !Array.isArray(v.metadata) &&
    // Distinguish from plain `{ metadata, data }` user objects by requiring
    // that values in the metadata map look like Uint8Array instances.
    Object.values(v.metadata).every((x) => x instanceof Uint8Array)
  );
}

export class PubSubClient {
  private handle: WorkflowHandle;
  private client: Client | undefined;
  private readonly workflowId: string;
  private readonly batchIntervalMs: number;
  private readonly maxBatchSize: number | undefined;
  private readonly maxRetryDurationMs: number;
  private readonly payloadConverter: PayloadConverter;
  private buffer: Array<{ topic: string; value: unknown }> = [];
  private pending: PublishEntry[] | null = null;
  private pendingSeq = 0;
  private pendingStartedAt: number | null = null;
  private publisherId: string = randomUUID().replace(/-/g, '').slice(0, 16);
  private sequence = 0;

  private readonly flushEvent = new ResolvableEvent();
  private flusherTask: Promise<void> | undefined;
  private flusherStopped = false;
  private flusherError: Error | undefined;
  private currentFlush: Promise<void> | null = null;

  constructor(handle: WorkflowHandle, options?: PubSubClientOptions) {
    this.handle = handle;
    this.workflowId = handle.workflowId;
    this.batchIntervalMs = msToNumber(options?.batchInterval ?? '2 seconds');
    this.maxBatchSize = options?.maxBatchSize;
    this.maxRetryDurationMs = msToNumber(options?.maxRetryDuration ?? '10 minutes');
    this.payloadConverter = defaultPayloadConverter;
  }

  /**
   * Create a PubSubClient from an explicit Temporal client and workflow ID.
   *
   * Use this when the caller has an explicit `Client` and `workflowId` in
   * hand (starters, BFFs, other workflows' activities). For code running
   * inside an activity that targets its own parent workflow, use
   * {@link PubSubClient.fromActivity}.
   *
   * A client created through this method follows continue-as-new chains in
   * `subscribe()` and uses the client's payload converter for per-item
   * `Payload` construction.
   */
  static create(client: Client, workflowId: string, options?: PubSubClientOptions): PubSubClient {
    const handle = client.workflow.getHandle(workflowId);
    const instance = new PubSubClient(handle, options);
    instance.client = client;
    // Prefer the Client's configured converter so custom converters flow
    // through; fall back to the default if unset.
    const clientConverter = client.options?.loadedDataConverter?.payloadConverter;
    if (clientConverter) {
      (instance as unknown as { payloadConverter: PayloadConverter }).payloadConverter = clientConverter;
    }
    return instance;
  }

  /**
   * Create a PubSubClient targeting the current activity's parent workflow.
   *
   * Must be called from within an activity. The Temporal client and
   * parent workflow id are taken from the activity context.
   */
  static fromActivity(options?: PubSubClientOptions): PubSubClient {
    const ctx = ActivityContext.current();
    const workflowId = ctx.info.workflowExecution.workflowId;
    return PubSubClient.create(ctx.client, workflowId, options);
  }

  /** Start the background flusher. Call before publishing. */
  start(): void {
    if (this.flusherTask) return;
    this.flusherStopped = false;
    this.flusherTask = this.runFlusher();
  }

  /**
   * Flush buffered (and pending) items and wait for server confirmation.
   *
   * Returns once the items buffered at call time have been signaled to
   * the workflow and acknowledged by the server. Returns immediately if
   * there is nothing to send.
   *
   * In addition to the declarative `forceFlush=true` on {@link publish}
   * and to the automatic flush on {@link [Symbol.asyncDispose]}, use
   * this when the caller needs proof that prior publications reached
   * the server at a moment that does not naturally correspond to a
   * specific event.
   *
   * Safe to call concurrently with `publish()` and with the background
   * flusher: the in-flight serialization on `flushOnce` makes signal
   * sends sequential. Items added concurrently after entry may
   * piggyback on this flush or be deferred to a subsequent one.
   *
   * Throws {@link FlushTimeoutError} if a pending batch cannot be sent
   * within `maxRetryDuration`. Also surfaces any deferred timeout from a
   * prior background flusher failure: without that, `flush()` could
   * return success against an empty buffer while an earlier batch had
   * already been dropped, hiding data loss.
   */
  async flush(): Promise<void> {
    this.throwPendingFlusherError();
    // Snapshot the sequence number that the items present at entry will
    // commit at. A concurrent producer that calls publish() during the
    // awaits below adds to the buffer at a later sequence — those items
    // belong to a future flush and must not extend this barrier.
    if (this.pending === null && this.buffer.length === 0) {
      return;
    }
    const baseSeq = this.pending !== null ? this.pendingSeq : this.sequence;
    const targetSeq = this.buffer.length > 0 ? baseSeq + 1 : baseSeq;
    // `sequence` only advances on a successful send, so reaching
    // `targetSeq` proves the entry-time items were confirmed. A later
    // batch (queued by a concurrent publisher and picked up by the
    // background flusher) may leave `pending` non-null afterward — we
    // do not wait on it.
    while (this.sequence < targetSeq) {
      await this.flushOnce();
    }
    this.throwPendingFlusherError();
  }

  /** Stop the flusher and flush remaining items. */
  async stop(): Promise<void> {
    if (!this.flusherTask) {
      await this.flushOnce();
      this.throwPendingFlusherError();
      return;
    }
    this.flusherStopped = true;
    this.flushEvent.set();
    try {
      await this.flusherTask;
    } finally {
      this.flusherTask = undefined;
    }
    // Final drain after the flusher exits. Repeat while either pending OR the
    // producer buffer has items: a single flushOnce() processes either
    // `pending` OR the buffer, not both.
    while (this.pending !== null || this.buffer.length > 0) {
      await this.flushOnce();
    }
    this.throwPendingFlusherError();
  }

  private throwPendingFlusherError(): void {
    if (this.flusherError) {
      const err = this.flusherError;
      this.flusherError = undefined;
      throw err;
    }
  }

  /** Dispose pattern: `await using client = PubSubClient.create(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  /**
   * Buffer a message for publishing.
   *
   * @param topic - Topic string.
   * @param value - Any value the payload converter can handle, or a pre-built
   *   `Payload` for zero-copy. The codec chain runs once on the signal
   *   envelope, not per item.
   * @param forceFlush - If true, wake the flusher to send immediately
   *   (fire-and-forget — does not block the caller).
   */
  publish(topic: string, value: unknown, forceFlush = false): void {
    this.buffer.push({ topic, value });
    if (forceFlush || (this.maxBatchSize !== undefined && this.buffer.length >= this.maxBatchSize)) {
      this.flushEvent.set();
    }
  }

  private encodeBuffer(entries: Array<{ topic: string; value: unknown }>): PublishEntry[] {
    const out: PublishEntry[] = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const { topic, value } = entries[i]!;
      const payload: Payload = isPayload(value) ? value : this.payloadConverter.toPayload(value);
      out[i] = { topic, data: encodePayloadWire(payload) };
    }
    return out;
  }

  private async runFlusher(): Promise<void> {
    while (!this.flusherStopped) {
      await Promise.race([this.flushEvent.wait(), sleep(this.batchIntervalMs)]);
      this.flushEvent.clear();
      if (this.flusherStopped) break;
      try {
        await this.flushOnce();
      } catch (err) {
        if (err instanceof FlushTimeoutError) {
          // Pending batch was dropped and can't be recovered. Stash the
          // error and stop the loop; stop() will surface it so data loss
          // is never silent.
          this.flusherError = err;
          break;
        }
        // Transient failures (network, signal rejection) leave `pending`
        // set so the next tick retries with the same sequence.
      }
    }
  }

  /** Serialize concurrent flush calls through a single in-flight promise. */
  private async flushOnce(): Promise<void> {
    while (this.currentFlush) {
      await this.currentFlush;
    }
    const p = this._doFlush();
    this.currentFlush = p;
    try {
      await p;
    } finally {
      if (this.currentFlush === p) this.currentFlush = null;
    }
  }

  /**
   * Send pending or buffered messages to the workflow via signal.
   *
   * On failure, the pending batch and sequence are kept for retry.
   * Only advances the confirmed sequence on success.
   */
  private async _doFlush(): Promise<void> {
    let batch: PublishEntry[];
    let seq: number;

    if (this.pending !== null) {
      // Retry path: check max_retry_duration
      if (
        this.pendingStartedAt !== null &&
        Date.now() - this.pendingStartedAt > this.maxRetryDurationMs
      ) {
        // Advance confirmed sequence so the next batch gets a fresh sequence
        // number. Without this, the next batch reuses pendingSeq, which the
        // workflow may have already accepted — causing silent dedup (data
        // loss). See `retry_timeout_sequence_reuse_causes_data_loss` test.
        this.sequence = this.pendingSeq;
        this.pending = null;
        this.pendingSeq = 0;
        this.pendingStartedAt = null;
        throw new FlushTimeoutError(
          `Flush retry exceeded maxRetryDuration (${this.maxRetryDurationMs}ms). ` +
            'Pending batch dropped. If the signal was delivered, items are in the log. ' +
            'If not, they are lost.'
        );
      }
      batch = this.pending;
      seq = this.pendingSeq;
    } else if (this.buffer.length > 0) {
      // New batch path: encode at flush time so the payload converter is
      // applied once per item.
      const raw = this.buffer;
      this.buffer = [];
      batch = this.encodeBuffer(raw);
      seq = this.sequence + 1;
      this.pending = batch;
      this.pendingSeq = seq;
      this.pendingStartedAt = Date.now();
    } else {
      return;
    }

    // On failure, the signal throws and pending stays set for retry.
    // On success, advance confirmed sequence and clear pending.
    await this.handle.signal<[PublishInput]>('__temporal_pubsub_publish', {
      items: batch,
      publisher_id: this.publisherId,
      sequence: seq,
    });
    this.sequence = seq;
    this.pending = null;
    this.pendingSeq = 0;
    this.pendingStartedAt = null;
  }

  /**
   * Async generator that polls for new items.
   *
   * Yielded items carry `data: Payload`. Use a payload converter such as
   * `defaultPayloadConverter.fromPayload<T>(item.data)` to decode.
   *
   * Automatically follows continue-as-new chains when created via
   * {@link PubSubClient.create}.
   *
   * @param topics - Topic filter. A single topic name, an array of topic
   *   names, or undefined. Undefined or an empty array means all topics.
   */
  async *subscribe(
    topics?: string | string[],
    fromOffset = 0,
    options?: SubscribeOptions
  ): AsyncGenerator<PubSubItem, void, unknown> {
    const pollCooldownMs = msToNumber(options?.pollCooldown ?? '100 milliseconds');
    const topicFilter: string[] =
      topics === undefined ? [] : typeof topics === 'string' ? [topics] : topics;
    let offset = fromOffset;

    while (true) {
      let result: PollResult;
      try {
        result = await this.handle.executeUpdate<PollResult, [PollInput]>('__temporal_pubsub_poll', {
          args: [{ topics: topicFilter, from_offset: offset }],
        });
      } catch (err) {
        if (err instanceof WorkflowUpdateFailedError) {
          const cause = err.cause;
          if (cause instanceof ApplicationFailure && cause.type === 'TruncatedOffset') {
            // Subscriber fell behind truncation. Retry from offset 0 which
            // the mixin treats as "from the beginning of whatever exists"
            // (i.e., from baseOffset).
            offset = 0;
            continue;
          }
          throw err;
        }
        if (err instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
          if (await this.followContinueAsNew()) {
            continue;
          }
          return;
        }
        throw err;
      }

      for (const wireItem of result.items) {
        yield {
          topic: wireItem.topic,
          data: decodePayloadWire(wireItem.data),
          offset: wireItem.offset,
        };
      }
      offset = result.next_offset;

      if (!result.more_ready && pollCooldownMs > 0) {
        await sleep(pollCooldownMs);
      }
    }
  }

  /** Query the current global offset. */
  async getOffset(): Promise<number> {
    return this.handle.query<number>('__temporal_pubsub_offset');
  }

  /**
   * Check if the workflow continued-as-new and re-target the handle.
   * Returns true if the handle was updated (caller should retry).
   */
  private async followContinueAsNew(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const desc = await this.handle.describe();
      if (desc.status.name === 'CONTINUED_AS_NEW') {
        this.handle = this.client.workflow.getHandle(this.workflowId);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}
