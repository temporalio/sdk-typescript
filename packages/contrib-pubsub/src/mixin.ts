/**
 * Workflow-side pub/sub mixin.
 *
 * TypeScript workflows are functions, not classes, so the "mixin" is a set of
 * functions that initialize and manage pub/sub state within workflow scope.
 *
 * Call `initPubSub()` at the start of your workflow function. Use the returned
 * handle to publish, drain, and get state for continue-as-new.
 */

import { condition, defineSignal, defineUpdate, defineQuery, setHandler } from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import {
  decodeData,
  encodeData,
  type PollInput,
  type PollResult,
  type PubSubItem,
  type PubSubState,
  type PublishInput,
  type _WireItem,
} from './types';

// Fixed handler names for cross-language interop
export const pubsubPublishSignal = defineSignal<[PublishInput]>('__pubsub_publish');
export const pubsubPollUpdate = defineUpdate<PollResult, [PollInput]>('__pubsub_poll');
export const pubsubOffsetQuery = defineQuery<number>('__pubsub_offset');

const MAX_POLL_RESPONSE_BYTES = 1_000_000;

/** Handle returned by initPubSub for interacting with pub/sub state. */
export interface PubSubHandle {
  /** Publish an item from within workflow code. Deterministic — just appends. */
  publish(topic: string, data: Uint8Array): void;

  /** Unblock all waiting poll handlers and reject new polls for CAN. */
  drain(): void;

  /**
   * Return a serializable snapshot of pub/sub state for continue-as-new.
   * Prunes publisher dedup entries older than publisherTtl seconds.
   */
  getState(publisherTtl?: number): PubSubState;

  /**
   * Discard log entries before upToOffset.
   * After truncation, polls requesting an offset before the new base
   * will receive an error.
   */
  truncate(upToOffset: number): void;
}

/**
 * Initialize pub/sub state and register signal/update/query handlers.
 *
 * Call at the start of your workflow function. For continue-as-new, pass
 * the prior state from `getState()`.
 *
 * @param priorState - State from a previous run via getState(). Pass undefined on first run.
 * @returns A handle for publishing, draining, and getting state.
 */
export function initPubSub(priorState?: PubSubState): PubSubHandle {
  // Decode wire items (base64) to in-memory items (Uint8Array)
  const log: PubSubItem[] = priorState?.log
    ? priorState.log.map((item, i) => ({
        topic: item.topic,
        data: decodeData(item.data),
        offset: (priorState.base_offset ?? 0) + i,
      }))
    : [];
  let baseOffset: number = priorState?.base_offset ?? 0;
  const publisherSequences: Record<string, number> = priorState?.publisher_sequences
    ? { ...priorState.publisher_sequences }
    : {};
  const publisherLastSeen: Record<string, number> = priorState?.publisher_last_seen
    ? { ...priorState.publisher_last_seen }
    : {};
  let draining = false;

  // Signal handler: receive publications from external clients with dedup
  setHandler(pubsubPublishSignal, (input: PublishInput) => {
    if (input.publisher_id) {
      const lastSeq = publisherSequences[input.publisher_id] ?? 0;
      if (input.sequence <= lastSeq) {
        return; // duplicate — skip
      }
      publisherSequences[input.publisher_id] = input.sequence;
      publisherLastSeen[input.publisher_id] = Date.now() / 1000; // seconds
    }
    for (const entry of input.items) {
      log.push({
        topic: entry.topic,
        data: decodeData(entry.data),
        offset: baseOffset + log.length,
      });
    }
  });

  // Update handler: long-poll subscription
  setHandler(
    pubsubPollUpdate,
    async (input: PollInput): Promise<PollResult> => {
      let logOffset = input.from_offset - baseOffset;
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
              `Current base offset is ${baseOffset}.`,
            type: 'TruncatedOffset',
            nonRetryable: true,
          });
        }
      }
      await condition(() => log.length > logOffset || draining);
      const allNew = log.slice(logOffset);

      // Build [globalOffset, item] candidates, filtering by topic if requested.
      const topicSet = input.topics.length > 0 ? new Set(input.topics) : null;
      const candidates: Array<[number, PubSubItem]> = [];
      for (let i = 0; i < allNew.length; i++) {
        const item = allNew[i]!;
        if (topicSet !== null && !topicSet.has(item.topic)) continue;
        candidates.push([baseOffset + logOffset + i, item]);
      }

      // Cap response size to ~1MB of estimated wire bytes.
      const wireItems: _WireItem[] = [];
      let size = 0;
      let moreReady = false;
      let nextOffset = baseOffset + log.length;
      for (const [off, item] of candidates) {
        const encoded = encodeData(item.data);
        const itemSize = encoded.length + item.topic.length;
        if (size + itemSize > MAX_POLL_RESPONSE_BYTES && wireItems.length > 0) {
          // Resume from this item on the next poll.
          nextOffset = off;
          moreReady = true;
          break;
        }
        size += itemSize;
        wireItems.push({ topic: item.topic, data: encoded, offset: off });
      }

      return {
        items: wireItems,
        next_offset: nextOffset,
        more_ready: moreReady,
      };
    },
    {
      // Validator: reject new polls when draining for continue-as-new
      validator(_input: PollInput): void {
        if (draining) {
          throw new Error('Workflow is draining for continue-as-new');
        }
      },
    }
  );

  // Query handler: current global offset
  setHandler(pubsubOffsetQuery, () => baseOffset + log.length);

  return {
    publish(topic: string, data: Uint8Array): void {
      log.push({ topic, data, offset: baseOffset + log.length });
    },

    drain(): void {
      draining = true;
    },

    getState(publisherTtl = 900): PubSubState {
      const now = Date.now() / 1000;
      const activeSeqs: Record<string, number> = {};
      const activeSeen: Record<string, number> = {};
      for (const pid of Object.keys(publisherSequences)) {
        // Missing timestamps are pruned (matches sdk-python). The signal
        // handler always sets both maps together, so absence indicates a
        // malformed snapshot rather than a supported upgrade path.
        const ts = publisherLastSeen[pid] ?? 0;
        if (now - ts < publisherTtl) {
          activeSeqs[pid] = publisherSequences[pid] ?? 0;
          activeSeen[pid] = ts;
        }
      }
      return {
        // Encode Uint8Array to base64 for serializable state.
        // Per-item offset is re-derivable from base_offset + index on reload,
        // so we leave it at 0 here.
        log: log.map((item) => ({ topic: item.topic, data: encodeData(item.data), offset: 0 })),
        base_offset: baseOffset,
        publisher_sequences: activeSeqs,
        publisher_last_seen: activeSeen,
      };
    },

    truncate(upToOffset: number): void {
      const logIndex = upToOffset - baseOffset;
      if (logIndex <= 0) return;
      if (logIndex > log.length) {
        throw new Error(
          `Cannot truncate to offset ${upToOffset}: only ${baseOffset + log.length} items exist`
        );
      }
      log.splice(0, logIndex);
      baseOffset = upToOffset;
    },
  };
}
