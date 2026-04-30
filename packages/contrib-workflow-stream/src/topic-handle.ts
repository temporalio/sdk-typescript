/**
 * Typed topic handles for Workflow Streams.
 *
 * A topic handle is a thin typed view over an underlying publisher. It
 * carries the topic name and the value type ``T`` so call sites do not
 * have to repeat them on every publish, and so subscribers reading the
 * same handle decode to the matching type.
 *
 * Unlike sdk-python, ``T`` here is purely a compile-time annotation:
 * TypeScript has no runtime type representation, so per-topic type
 * uniformity cannot be enforced by the runtime. {@link WorkflowStream}
 * and {@link WorkflowStreamClient} do memoize handles by name, so two
 * `topic('foo')` calls return the same handle instance — but the two
 * calls' ``T`` parameters are erased and not compared.
 */

import type { Payload, PayloadConverter } from '@temporalio/common';
import type { SubscribeOptions, WorkflowStreamClient } from './client';
import type { WorkflowStream } from './stream';
import type { WorkflowStreamItem } from './types';

/**
 * Client-side handle for publishing to and subscribing from a single topic.
 *
 * Constructed via {@link WorkflowStreamClient.topic}. Publishes share the
 * underlying client's batching, dedup, and codec path; this object holds
 * only the topic name and the type binding.
 *
 * @experimental
 */
export class TopicHandle<T = unknown> {
  /** @internal */
  constructor(
    private readonly client: WorkflowStreamClient,
    public readonly name: string,
  ) {}

  /**
   * Buffer ``value`` for publishing on this topic.
   *
   * Equivalent to the underlying client's publish path; the value flows
   * through the same buffer, batch interval, and dedup sequence.
   *
   * @param value Value to publish. Goes through the client's payload
   *   converter at flush time. A pre-built {@link Payload} bypasses
   *   conversion (zero-copy fast path), regardless of the handle's
   *   bound type.
   * @param options.forceFlush If true, wake the flusher to send
   *   immediately (fire-and-forget — does not block the caller).
   */
  publish(value: T | Payload, options?: { forceFlush?: boolean }): void {
    // Cast through `unknown` so the internal publisher accepts the value;
    // the per-handle T is compile-time only.
    (this.client as unknown as { _publishToTopic(name: string, value: unknown, forceFlush: boolean): void })
      ._publishToTopic(this.name, value, options?.forceFlush ?? false);
  }

  /**
   * Async iterator over items on this topic, decoded as ``T`` via the
   * client's configured payload converter (custom converter on the
   * underlying {@link WorkflowStreamClient.create | Client} flows
   * through; otherwise the default).
   *
   * For raw {@link Payload} access, or any other decode path that
   * differs from the handle's bound ``T``, call
   * {@link WorkflowStreamClient.subscribe} directly — it yields
   * {@link WorkflowStreamItem | WorkflowStreamItem<Payload>}.
   *
   * @param fromOffset Global offset to start reading from.
   * @param options.pollCooldown Minimum interval between polls when
   *   there are no new items. Default 100ms.
   */
  async *subscribe(
    fromOffset = 0,
    options?: SubscribeOptions,
  ): AsyncGenerator<WorkflowStreamItem<T>, void, unknown> {
    const converter = (this.client as unknown as { payloadConverter: PayloadConverter }).payloadConverter;
    for await (const raw of this.client.subscribe(this.name, fromOffset, options)) {
      yield {
        topic: raw.topic,
        data: converter.fromPayload<T>(raw.data),
        offset: raw.offset,
      };
    }
  }
}

/**
 * Workflow-side handle for publishing to a single topic.
 *
 * Constructed via {@link WorkflowStream.topic}. Has no ``subscribe``:
 * workflows do not consume their own stream.
 *
 * @experimental
 */
export class WorkflowTopicHandle<T = unknown> {
  /** @internal */
  constructor(
    private readonly stream: WorkflowStream,
    public readonly name: string,
  ) {}

  /**
   * Append ``value`` to the workflow stream on this topic.
   *
   * @param value Value to publish. Goes through the workflow's default
   *   payload converter. A pre-built {@link Payload} bypasses
   *   conversion, regardless of the handle's bound type.
   */
  publish(value: T | Payload): void {
    (this.stream as unknown as { _publishToTopic(name: string, value: unknown): void })
      ._publishToTopic(this.name, value);
  }
}
