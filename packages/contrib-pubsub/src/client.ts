/**
 * External-side pub/sub client.
 *
 * Used by activities, starters, and any code with a workflow handle to publish
 * messages and subscribe to topics on a pub/sub workflow.
 */

import { randomUUID } from 'crypto';
import { Client, WorkflowHandle, WorkflowUpdateRPCTimeoutOrCancelledError } from '@temporalio/client';
import type { PollInput, PollResult, PubSubItem, PublishEntry, PublishInput } from './types';

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

export class PubSubClient {
  private handle: WorkflowHandle;
  private readonly client: Client | undefined;
  private readonly workflowId: string;
  private readonly batchInterval: number;
  private readonly maxBatchSize: number | undefined;
  private readonly maxRetryDuration: number;
  private buffer: PublishEntry[] = [];
  private pending: PublishEntry[] | null = null;
  private pendingSeq = 0;
  private pendingStartedAt: number | null = null;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushPromise: Promise<void> | undefined;
  private publisherId: string = randomUUID().replace(/-/g, '').slice(0, 16);
  private sequence = 0;

  constructor(handle: WorkflowHandle, options?: PubSubClientOptions) {
    this.handle = handle;
    this.workflowId = handle.workflowId;
    this.batchInterval = options?.batchInterval ?? 2.0;
    this.maxBatchSize = options?.maxBatchSize;
    this.maxRetryDuration = options?.maxRetryDuration ?? 600;
  }

  /**
   * Create a PubSubClient from a Temporal client and workflow ID.
   * Preferred constructor — enables continue-as-new following in subscribe().
   */
  static create(client: Client, workflowId: string, options?: PubSubClientOptions): PubSubClient {
    const handle = client.workflow.getHandle(workflowId);
    const instance = new PubSubClient(handle, options);
    (instance as unknown as { client: Client | undefined }).client = client;
    return instance;
  }

  /** Start the background flush timer. Call before publishing. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this._flush();
    }, this.batchInterval * 1000);
  }

  /** Stop the flush timer and flush remaining items. */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this._flush();
  }

  /**
   * Buffer a message for publishing.
   * @param priority - If true, triggers immediate flush (fire-and-forget).
   */
  publish(topic: string, data: number[], priority = false): void {
    this.buffer.push({ topic, data });
    if (priority || (this.maxBatchSize !== undefined && this.buffer.length >= this.maxBatchSize)) {
      void this._flush();
    }
  }

  /**
   * Send pending or buffered messages to the workflow via signal.
   *
   * On failure, the pending batch and sequence are kept for retry.
   * Only advances the confirmed sequence on success.
   */
  private async _flush(): Promise<void> {
    // Simple serialization: wait for any in-progress flush
    if (this.flushPromise) {
      await this.flushPromise;
    }

    let batch: PublishEntry[];
    let seq: number;

    if (this.pending !== null) {
      // Retry path: check max_retry_duration
      if (
        this.pendingStartedAt !== null &&
        (Date.now() - this.pendingStartedAt) / 1000 > this.maxRetryDuration
      ) {
        this.pending = null;
        this.pendingSeq = 0;
        this.pendingStartedAt = null;
        throw new FlushTimeoutError(
          `Flush retry exceeded maxRetryDuration (${this.maxRetryDuration}s). ` +
          'Pending batch dropped.'
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

    const doFlush = async (): Promise<void> => {
      // On failure, the signal throws and pending stays set for retry.
      // On success, we advance confirmed sequence and clear pending.
      await this.handle.signal<[PublishInput]>('__pubsub_publish', {
        items: batch,
        publisher_id: this.publisherId,
        sequence: seq,
      });
      this.sequence = seq;
      this.pending = null;
      this.pendingSeq = 0;
      this.pendingStartedAt = null;
    };

    this.flushPromise = doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = undefined;
    }
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
          args: [{ topics: topics ?? [], from_offset: offset, timeout: 300.0 }],
        });
      } catch (err) {
        if (err instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
          if (await this.followContinueAsNew()) {
            continue;
          }
          return;
        }
        throw err;
      }

      for (const item of result.items) {
        yield item;
      }
      offset = result.next_offset;

      if (pollCooldown > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollCooldown * 1000));
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
