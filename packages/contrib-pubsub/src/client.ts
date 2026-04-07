/**
 * External-side pub/sub client.
 *
 * Used by activities, starters, and any code with a workflow handle to publish
 * messages and subscribe to topics on a pub/sub workflow.
 */

import { randomUUID } from 'crypto';
import { Client, WorkflowHandle, WorkflowUpdateRPCTimeoutOrCancelledError } from '@temporalio/client';
import type { PollInput, PollResult, PubSubItem, PublishEntry, PublishInput } from './types';

export interface PubSubClientOptions {
  /** Seconds between automatic flushes. Default: 2.0 */
  batchInterval?: number;
  /** Auto-flush when buffer reaches this size. */
  maxBatchSize?: number;
}

export class PubSubClient {
  private handle: WorkflowHandle;
  private readonly client: Client | undefined;
  private readonly workflowId: string;
  private readonly batchInterval: number;
  private readonly maxBatchSize: number | undefined;
  private buffer: PublishEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushPromise: Promise<void> | undefined;
  private publisherId: string = randomUUID().replace(/-/g, '');
  private sequence: number = 0;

  constructor(handle: WorkflowHandle, options?: PubSubClientOptions) {
    this.handle = handle;
    this.workflowId = handle.workflowId;
    this.batchInterval = options?.batchInterval ?? 2.0;
    this.maxBatchSize = options?.maxBatchSize;
  }

  /**
   * Create a PubSubClient from a Temporal client and workflow ID.
   * Preferred constructor — enables continue-as-new following in subscribe().
   */
  static forWorkflow(client: Client, workflowId: string, options?: PubSubClientOptions): PubSubClient {
    const handle = client.workflow.getHandle(workflowId);
    const instance = new PubSubClient(handle, options);
    (instance as unknown as { client: Client | undefined }).client = client;
    return instance;
  }

  /** Start the background flush timer. Call before publishing. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.batchInterval * 1000);
  }

  /** Stop the flush timer and flush remaining items. */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  /** Buffer a message for publishing. */
  publish(topic: string, data: number[], priority = false): void {
    this.buffer.push({ topic, data });
    if (priority || (this.maxBatchSize !== undefined && this.buffer.length >= this.maxBatchSize)) {
      void this.flush();
    }
  }

  /** Send all buffered messages to the workflow via signal. */
  async flush(): Promise<void> {
    // Simple serialization: wait for any in-progress flush
    if (this.flushPromise) {
      await this.flushPromise;
    }
    if (this.buffer.length === 0) return;

    this.sequence += 1;
    const batch = this.buffer;
    this.buffer = [];

    const doFlush = async (): Promise<void> => {
      try {
        await this.handle.signal<[PublishInput]>('__pubsub_publish', {
          items: batch,
          publisher_id: this.publisherId,
          sequence: this.sequence,
        });
      } catch (err) {
        // Restore items for retry, but keep advanced sequence to avoid
        // dedup-dropping newly buffered items merged with retry batch
        this.buffer = [...batch, ...this.buffer];
        throw err;
      }
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
   * Automatically follows continue-as-new chains when created via forWorkflow().
   */
  async *subscribe(
    topics?: string[],
    fromOffset = 0,
    options?: { pollInterval?: number }
  ): AsyncGenerator<PubSubItem, void, unknown> {
    const pollInterval = options?.pollInterval ?? 0.1;
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

      if (pollInterval > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
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
