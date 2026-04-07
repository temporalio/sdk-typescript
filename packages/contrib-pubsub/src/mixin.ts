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
import type { PollInput, PollResult, PubSubItem, PubSubState, PublishInput } from './types';

// Fixed handler names for cross-language interop
export const pubsubPublishSignal = defineSignal<[PublishInput]>('__pubsub_publish');
export const pubsubPollUpdate = defineUpdate<PollResult, [PollInput]>('__pubsub_poll');
export const pubsubOffsetQuery = defineQuery<number>('__pubsub_offset');

/** Handle returned by initPubSub for interacting with pub/sub state. */
export interface PubSubHandle {
  /** Publish an item from within workflow code. Deterministic — just appends. */
  publish(topic: string, data: number[]): void;

  /** Unblock all waiting poll handlers and reject new polls for CAN. */
  drain(): void;

  /** Return a serializable snapshot of pub/sub state for continue-as-new. */
  getState(): PubSubState;
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
  const log: PubSubItem[] = priorState?.log ? [...priorState.log] : [];
  const baseOffset: number = priorState?.base_offset ?? 0;
  const publisherSequences: Record<string, number> = priorState?.publisher_sequences
    ? { ...priorState.publisher_sequences }
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
    }
    for (const entry of input.items) {
      log.push({ topic: entry.topic, data: entry.data });
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
      return { items: filtered, next_offset: nextOffset };
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
    publish(topic: string, data: number[]): void {
      log.push({ topic, data });
    },

    drain(): void {
      draining = true;
    },

    getState(): PubSubState {
      return {
        log: [...log],
        base_offset: baseOffset,
        publisher_sequences: { ...publisherSequences },
      };
    },
  };
}
