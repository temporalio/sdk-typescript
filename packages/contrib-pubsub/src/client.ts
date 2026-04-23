/**
 * External-side pub/sub client.
 *
 * Used by activities, starters, and any code with a workflow handle to publish
 * messages and subscribe to topics on a pub/sub workflow.
 */

import { randomUUID } from 'crypto';
import { Context as ActivityContext } from '@temporalio/activity';
import { Client, WorkflowHandle, WorkflowUpdateFailedError, WorkflowUpdateRPCTimeoutOrCancelledError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import {
  decodeData,
  encodeData,
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
  /** Seconds between automatic flushes. Default: 2.0 */
  batchInterval?: number;
  /** Auto-flush when buffer reaches this size. */
  maxBatchSize?: number;
  /**
   * Maximum seconds to retry a failed flush before throwing.
   * Must be less than the workflow's publisherTtl (default 900s) to preserve
   * exactly-once delivery. Default: 600.
   */
  maxRetryDuration?: number;
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

export class PubSubClient {
  private handle: WorkflowHandle;
  private client: Client | undefined;
  private readonly workflowId: string;
  private readonly batchInterval: number;
  private readonly maxBatchSize: number | undefined;
  private readonly maxRetryDuration: number;
  private buffer: PublishEntry[] = [];
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
    this.batchInterval = options?.batchInterval ?? 2.0;
    this.maxBatchSize = options?.maxBatchSize;
    this.maxRetryDuration = options?.maxRetryDuration ?? 600;
  }

  /**
   * Create a PubSubClient from a Temporal client and workflow ID.
   *
   * When called inside an activity, `client` and `workflowId` can be omitted —
   * they are inferred from `Context.current()`.
   *
   * This is the preferred constructor; it enables continue-as-new following in
   * `subscribe()`.
   */
  static create(
    client?: Client,
    workflowId?: string,
    options?: PubSubClientOptions
  ): PubSubClient {
    let resolvedClient: Client;
    let resolvedId: string;
    if (client === undefined || workflowId === undefined) {
      // Context.current() throws if not inside an activity — let that propagate
      // with its native error so the caller sees the right message.
      const ctx = ActivityContext.current();
      resolvedClient = client ?? ctx.client;
      resolvedId = workflowId ?? ctx.info.workflowExecution.workflowId;
    } else {
      resolvedClient = client;
      resolvedId = workflowId;
    }
    const handle = resolvedClient.workflow.getHandle(resolvedId);
    const instance = new PubSubClient(handle, options);
    instance.client = resolvedClient;
    return instance;
  }

  /** Start the background flusher. Call before publishing. */
  start(): void {
    if (this.flusherTask) return;
    this.flusherStopped = false;
    this.flusherTask = this.runFlusher();
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
    // Final drain after the flusher exits.
    await this.flushOnce();
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
   * @param data - Opaque byte payload.
   * @param priority - If true, wake the flusher to send immediately.
   */
  publish(topic: string, data: Uint8Array, priority = false): void {
    this.buffer.push({ topic, data: encodeData(data) });
    if (priority || (this.maxBatchSize !== undefined && this.buffer.length >= this.maxBatchSize)) {
      this.flushEvent.set();
    }
  }

  private async runFlusher(): Promise<void> {
    while (!this.flusherStopped) {
      await Promise.race([this.flushEvent.wait(), sleep(this.batchInterval * 1000)]);
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

  /**
   * Serialize concurrent flush calls through a single in-flight promise.
   */
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
        (Date.now() - this.pendingStartedAt) / 1000 > this.maxRetryDuration
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
          `Flush retry exceeded maxRetryDuration (${this.maxRetryDuration}s). ` +
            'Pending batch dropped. If the signal was delivered, items are in the log. ' +
            'If not, they are lost.'
        );
      }
      batch = this.pending;
      seq = this.pendingSeq;
    } else if (this.buffer.length > 0) {
      // New batch path
      seq = this.sequence + 1;
      batch = this.buffer;
      this.buffer = [];
      this.pending = batch;
      this.pendingSeq = seq;
      this.pendingStartedAt = Date.now();
    } else {
      return;
    }

    // On failure, the signal throws and pending stays set for retry.
    // On success, advance confirmed sequence and clear pending.
    await this.handle.signal<[PublishInput]>('__pubsub_publish', {
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
   * Automatically follows continue-as-new chains when created via create().
   */
  async *subscribe(
    topics?: string[],
    fromOffset = 0,
    options?: { pollCooldown?: number }
  ): AsyncGenerator<PubSubItem, void, unknown> {
    const pollCooldown = options?.pollCooldown ?? 0.1;
    let offset = fromOffset;

    while (true) {
      let result: PollResult;
      try {
        result = await this.handle.executeUpdate<PollResult, [PollInput]>('__pubsub_poll', {
          args: [{ topics: topics ?? [], from_offset: offset }],
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
          data: decodeData(wireItem.data),
          offset: wireItem.offset,
        };
      }
      offset = result.next_offset;

      if (!result.more_ready && pollCooldown > 0) {
        await sleep(pollCooldown * 1000);
      }
    }
  }

  /** Query the current global offset. */
  async getOffset(): Promise<number> {
    return this.handle.query<number>('__pubsub_offset');
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
