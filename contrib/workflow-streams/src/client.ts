/**
 * External-side workflow stream client.
 *
 * Used by activities, starters, and any code with a workflow handle to publish
 * messages and subscribe to topics on a workflow stream workflow.
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
import type { Client, WorkflowHandle } from '@temporalio/client';
import {
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  WorkflowUpdateStage,
} from '@temporalio/client';
import {
  ApplicationFailure,
  defaultPayloadConverter,
  WorkflowNotFoundError,
  type Payload,
  type PayloadConverter,
} from '@temporalio/common';
import type { Duration } from '@temporalio/common/lib/time';
import { msToNumber } from '@temporalio/common/lib/time';
import { decodePayloadWire, encodePayloadWire } from './codec';
import type { PollInput, PollResult, WorkflowStreamItem, PublishEntry, PublishInput } from './types';
import { TopicHandle } from './topic-handle';

/** Thrown when a flush retry exceeds maxRetryDuration. */
export class FlushTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlushTimeoutError';
  }
}

export interface WorkflowStreamClientOptions {
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

export class WorkflowStreamClient {
  private handle: WorkflowHandle;
  private client: Client | undefined;
  private readonly workflowId: string;
  // Run id the most recent poll's update was admitted to. Captured before
  // awaiting the outcome so a mid-poll continue-as-new can be detected by
  // describing that specific run. Undefined until the first poll is admitted.
  private polledRunId: string | undefined;
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
  private readonly topicHandles = new Map<string, TopicHandle<unknown>>();

  constructor(handle: WorkflowHandle, options?: WorkflowStreamClientOptions) {
    this.handle = handle;
    this.workflowId = handle.workflowId;
    this.batchIntervalMs = msToNumber(options?.batchInterval ?? '2 seconds');
    this.maxBatchSize = options?.maxBatchSize;
    this.maxRetryDurationMs = msToNumber(options?.maxRetryDuration ?? '10 minutes');
    this.payloadConverter = defaultPayloadConverter;
  }

  /**
   * Create a WorkflowStreamClient from an explicit Temporal client and workflow ID.
   *
   * Use this when the caller has an explicit `Client` and `workflowId` in
   * hand (starters, BFFs, other workflows' activities). For code running
   * inside an activity that targets its own parent workflow, use
   * {@link WorkflowStreamClient.fromWithinActivity}.
   *
   * A client created through this method follows continue-as-new chains in
   * `subscribe()` and uses the client's payload converter for per-item
   * `Payload` construction.
   */
  static create(client: Client, workflowId: string, options?: WorkflowStreamClientOptions): WorkflowStreamClient {
    const handle = client.workflow.getHandle(workflowId);
    const instance = new WorkflowStreamClient(handle, options);
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
   * Create a WorkflowStreamClient targeting the current activity's parent workflow.
   *
   * Must be called from within an activity. The Temporal client and
   * parent workflow id are taken from the activity context.
   */
  static fromWithinActivity(options?: WorkflowStreamClientOptions): WorkflowStreamClient {
    const ctx = ActivityContext.current();
    const workflowExecution = ctx.info.workflowExecution;
    if (workflowExecution === undefined) {
      throw new Error(
        'fromWithinActivity requires an activity scheduled by a workflow; this ' +
          'activity has no parent workflow. From a standalone activity, use ' +
          'WorkflowStreamClient.create(client, workflowId) with the target ' +
          'workflow id passed in explicitly.'
      );
    }
    return WorkflowStreamClient.create(ctx.client, workflowExecution.workflowId, options);
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

  private throwPendingFlusherError(): void {
    if (this.flusherError) {
      const err = this.flusherError;
      this.flusherError = undefined;
      throw err;
    }
  }

  /**
   * Dispose pattern: stop the flusher and drain remaining items.
   *
   * Use via `await using client = WorkflowStreamClient.create(...)` so the
   * scope exit guarantees a final drain. For tests or call sites that
   * cannot use `await using`, invoke this method directly:
   * `await client[Symbol.asyncDispose]()`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.flusherTask) {
      // Lazy-start path was never triggered (no publish, or only flush()
      // was used). A single flushOnce() drains anything left in the buffer.
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

  /**
   * Get a typed handle for publishing to and subscribing from ``name``.
   *
   * Repeated calls with the same name return the same handle instance.
   * The type parameter ``T`` is purely a compile-time annotation — see
   * the module note in {@link TopicHandle} for the difference from
   * sdk-python's runtime type-uniformity check.
   */
  topic<T = unknown>(name: string): TopicHandle<T> {
    let handle = this.topicHandles.get(name);
    if (handle === undefined) {
      handle = new TopicHandle<T>(this, name, (topic, value, forceFlush) =>
        this.publishToTopic(topic, value, forceFlush)
      );
      this.topicHandles.set(name, handle as TopicHandle<unknown>);
    }
    return handle as TopicHandle<T>;
  }

  private publishToTopic(topic: string, value: unknown, forceFlush: boolean): void {
    // Lazy-start the background flusher on first publish. Skipped if dispose
    // already ran, so a publish-after-dispose surfaces as a buffered item that
    // never flushes (which the next dispose would catch) rather than silently
    // resurrecting the flusher.
    if (this.flusherTask === undefined && !this.flusherStopped) {
      this.flusherTask = this.runFlusher();
    }
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
      if (this.pendingStartedAt !== null && Date.now() - this.pendingStartedAt > this.maxRetryDurationMs) {
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
    await this.handle.signal<[PublishInput]>('__temporal_workflow_stream_publish', {
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
   * Default — yields items with `data: Payload` (no decode). Use a payload
   * converter such as `defaultPayloadConverter.fromPayload<T>(item.data)`
   * to decode at the call site.
   *
   * With `resultType: true` — each item is decoded via the client's
   * configured payload converter and yielded as the generic `T`.
   *
   * Automatically follows continue-as-new chains when created via
   * {@link WorkflowStreamClient.create}.
   *
   * @param topics - Topic filter. A single topic name, an array of topic
   *   names, or undefined. Undefined or an empty array means all topics.
   */
  subscribe(
    topics?: string | string[],
    fromOffset?: number,
    options?: SubscribeOptions
  ): AsyncGenerator<WorkflowStreamItem<Payload>, void, unknown>;
  subscribe<T>(
    topics: string | string[] | undefined,
    fromOffset: number,
    options: SubscribeOptions & { resultType: true }
  ): AsyncGenerator<WorkflowStreamItem<T>, void, unknown>;
  async *subscribe<T = Payload>(
    topics?: string | string[],
    fromOffset = 0,
    options?: SubscribeOptions & { resultType?: boolean }
  ): AsyncGenerator<WorkflowStreamItem<T>, void, unknown> {
    const pollCooldownMs = msToNumber(options?.pollCooldown ?? '100 milliseconds');
    const topicFilter: string[] = topics === undefined ? [] : typeof topics === 'string' ? [topics] : topics;
    let offset = fromOffset;

    while (true) {
      let result: PollResult;
      try {
        // Wait only for ACCEPTED so the handle (and the run id it was admitted
        // to) is available before we await the outcome; if the run
        // continues-as-new mid-poll, result() rejects but we still know which
        // run to inspect.
        const updateHandle = await this.handle.startUpdate<PollResult, [PollInput]>('__temporal_workflow_stream_poll', {
          args: [{ topics: topicFilter, from_offset: offset }],
          waitForStage: WorkflowUpdateStage.ACCEPTED,
        });
        this.polledRunId = updateHandle.workflowRunId;
        result = await updateHandle.result();
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
          if (cause instanceof ApplicationFailure && cause.type === 'StreamDraining') {
            // Workflow is detaching for continue-as-new. Back off and retry; the
            // poll lands on the successor run once the rollover completes.
            if (pollCooldownMs > 0) {
              await sleep(pollCooldownMs);
            }
            continue;
          }
          if (cause instanceof ApplicationFailure && cause.type === 'AcceptedUpdateCompletedWorkflow') {
            // Workflow returned (or continued-as-new) before this poll's
            // update completed. Either follow the chain or exit cleanly.
            if (await this.followContinueAsNew()) {
              continue;
            }
            return;
          }
          throw err;
        }
        if (err instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
          if (await this.followContinueAsNew()) {
            continue;
          }
          return;
        }
        if (err instanceof WorkflowNotFoundError) {
          // Workflow may have completed between polls. subscribe() exits
          // cleanly on terminal status so callers don't have to wrap the
          // iterator in error handling for the normal end-of-stream case.
          if (await this.followContinueAsNew()) {
            continue;
          }
          if (await this.isInTerminalState()) {
            return;
          }
          throw err;
        }
        throw err;
      }

      const decode = options?.resultType === true;
      for (const wireItem of result.items) {
        const payload = decodePayloadWire(wireItem.data);
        yield {
          topic: wireItem.topic,
          data: decode ? this.payloadConverter.fromPayload<T>(payload) : (payload as unknown as T),
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
    return this.handle.query<number>('__temporal_workflow_stream_offset');
  }

  /**
   * Describe the specific run the most recent poll was admitted to. Describing
   * that run (rather than the latest) is what lets a continue-as-new be
   * detected: a rolled-over run is closed with status CONTINUED_AS_NEW, whereas
   * the latest run would report RUNNING. Falls back to the latest run when no
   * run id has been captured yet, or when no client is available to target one.
   */
  private describePolledRun() {
    const handle = this.client ? this.client.workflow.getHandle(this.workflowId, this.polledRunId) : this.handle;
    return handle.describe();
  }

  /**
   * Check if the polled run continued-as-new and re-target the handle. Returns
   * true if the handle was updated (caller should retry). The successor run id
   * is not needed — re-targeting to an unpinned handle makes the next poll
   * address the latest (successor) run.
   */
  private async followContinueAsNew(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const desc = await this.describePolledRun();
      if (desc.status.name === 'CONTINUED_AS_NEW') {
        this.handle = this.client.workflow.getHandle(this.workflowId);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Return true if the polled run has reached a terminal state. Used by
   * `subscribe()` to distinguish "workflow finished — stream is done" from
   * "wrong workflow id" when a poll surfaces `WorkflowNotFoundError`.
   */
  private async isInTerminalState(): Promise<boolean> {
    try {
      const desc = await this.describePolledRun();
      const name = desc.status.name;
      return (
        name === 'COMPLETED' ||
        name === 'FAILED' ||
        name === 'CANCELLED' ||
        name === 'TERMINATED' ||
        name === 'TIMED_OUT'
      );
    } catch {
      return false;
    }
  }
}

export { TopicHandle } from './topic-handle';
export type { WorkflowStreamItem, PublishEntry, PublishInput, PollInput, PollResult } from './types';
