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
import type { PollInput, PollResult, PubSubItem, PubSubState, PublishInput, _WireItem } from './types';
import { encodeData, decodeData } from './types';

// Fixed handler names for cross-language interop
export const pubsubPublishSignal = defineSignal<[PublishInput]>('__pubsub_publish');
export const pubsubPollUpdate = defineUpdate<PollResult, [PollInput]>('__pubsub_poll');
export const pubsubOffsetQuery = defineQuery<number>('__pubsub_offset');

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
    ? priorState.log.map((item) => ({ topic: item.topic, data: decodeData(item.data) }))
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
      // Decode base64 wire data to Uint8Array for in-memory storage
      log.push({ topic: entry.topic, data: decodeData(entry.data) });
    }
  });

  // Update handler: long-poll subscription
  setHandler(
    pubsubPollUpdate,
    async (input: PollInput): Promise<PollResult> => {
      const logOffset = input.from_offset - baseOffset;
      if (logOffset < 0) {
        throw new Error(
          `Requested offset ${input.from_offset} is before base offset ${baseOffset} (log has been truncated)`
        );
      }
      await condition(
        () => log.length > logOffset || draining,
        input.timeout * 1000, // convert seconds to ms
      );
      const allNew = log.slice(logOffset);
      const nextOffset = baseOffset + log.length;
      let filtered: PubSubItem[];
      if (input.topics.length > 0) {
        const topicSet = new Set(input.topics);
        filtered = allNew.filter((item) => topicSet.has(item.topic));
      } else {
        filtered = [...allNew];
      }
      // Encode Uint8Array to base64 for wire response
      return {
        items: filtered.map((item) => ({ topic: item.topic, data: encodeData(item.data) })),
        next_offset: nextOffset,
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
      log.push({ topic, data });
    },

    drain(): void {
      draining = true;
    },

    getState(publisherTtl = 900): PubSubState {
      const now = Date.now() / 1000;
      const activeSeqs: Record<string, number> = {};
      const activeSeen: Record<string, number> = {};
      for (const pid of Object.keys(publisherSequences)) {
        const ts = publisherLastSeen[pid];
        if (ts === undefined || now - ts < publisherTtl) {
          activeSeqs[pid] = publisherSequences[pid] ?? 0;
          if (ts !== undefined) {
            activeSeen[pid] = ts;
          }
        }
      }
      return {
        // Encode Uint8Array to base64 for serializable state
        log: log.map((item) => ({ topic: item.topic, data: encodeData(item.data) })),
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
