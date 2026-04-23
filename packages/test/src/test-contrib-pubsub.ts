/**
 * E2E integration tests for @temporalio/contrib-pubsub.
 *
 * Ported from sdk-python tests/contrib/pubsub/test_pubsub.py.
 */

import { randomUUID } from 'crypto';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowHandle, WorkflowUpdateFailedError } from '@temporalio/client';
import {
  FlushTimeoutError,
  PubSubClient,
  type PollInput,
  type PollResult,
  type PubSubItem,
  type PubSubState,
  type PublishEntry,
  type PublishInput,
  encodeData,
  pubsubOffsetQuery,
  pubsubPublishSignal,
  pubsubPollUpdate,
} from '@temporalio/contrib-pubsub';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  activityPublishWorkflow,
  basicPubSubWorkflow,
  continueAsNewTypedWorkflow,
  flushOnExitWorkflow,
  getStateWithTtlQuery,
  maxBatchWorkflow,
  multiTopicWorkflow,
  priorityWorkflow,
  truncateSignalWorkflow,
  ttlTestWorkflow,
  workflowSidePublishWorkflow,
} from './workflows/contrib-pubsub';
import * as pubsubActivities from './activities/contrib-pubsub';

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/contrib-pubsub'),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function entry(topic: string, data: string): PublishEntry {
  return { topic, data: encodeData(encoder.encode(data)) };
}

async function collectItems(
  handle: WorkflowHandle,
  topics: string[] | undefined,
  fromOffset: number,
  expectedCount: number,
  timeoutMs = 15_000
): Promise<PubSubItem[]> {
  const client = new PubSubClient(handle);
  const items: PubSubItem[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const gen = client.subscribe(topics, fromOffset, { pollCooldown: 0 });
    for await (const item of gen) {
      if (controller.signal.aborted) break;
      items.push(item);
      if (items.length >= expectedCount) {
        await gen.return();
        break;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return items;
}

test('activity_publish_and_subscribe — activity publishes, client subscribes', async (t) => {
  const count = 10;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: pubsubActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(activityPublishWorkflow, { args: [count] });
    const items = await collectItems(handle, undefined, 0, count + 1);
    t.is(items.length, count + 1);
    for (let i = 0; i < count; i++) {
      t.is(items[i]!.topic, 'events');
      t.is(decoder.decode(items[i]!.data), `item-${i}`);
    }
    t.is(items[count]!.topic, 'status');
    t.is(decoder.decode(items[count]!.data), 'activity_done');
    await handle.signal('close');
  });
});

test('topic_filtering — subscriber gets only requested topics', async (t) => {
  const count = 9;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: pubsubActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(multiTopicWorkflow, { args: [count] });

    const aItems = await collectItems(handle, ['a'], 0, 3);
    t.is(aItems.length, 3);
    t.true(aItems.every((it) => it.topic === 'a'));

    const acItems = await collectItems(handle, ['a', 'c'], 0, 6);
    t.is(acItems.length, 6);
    t.true(acItems.every((it) => it.topic === 'a' || it.topic === 'c'));

    const allItems = await collectItems(handle, undefined, 0, 9);
    t.is(allItems.length, 9);

    await handle.signal('close');
  });
});

test('subscribe_from_offset — non-zero starting offset', async (t) => {
  const count = 5;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(workflowSidePublishWorkflow, { args: [count] });

    const items = await collectItems(handle, undefined, 3, 2);
    t.is(items.length, 2);
    t.is(decoder.decode(items[0]!.data), 'item-3');
    t.is(decoder.decode(items[1]!.data), 'item-4');

    const allItems = await collectItems(handle, undefined, 0, 5);
    t.is(allItems.length, 5);

    await handle.signal('close');
  });
});

test('per_item_offsets — each yielded item carries its global offset', async (t) => {
  const count = 5;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(workflowSidePublishWorkflow, { args: [count] });

    const items = await collectItems(handle, undefined, 0, count);
    t.is(items.length, count);
    for (let i = 0; i < count; i++) {
      t.is(items[i]!.offset, i);
    }

    const laterItems = await collectItems(handle, undefined, 3, 2);
    t.is(laterItems[0]!.offset, 3);
    t.is(laterItems[1]!.offset, 4);

    await handle.signal('close');
  });
});

test('per_item_offsets_with_topic_filter — offsets are global, not per-topic', async (t) => {
  const count = 9;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: pubsubActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(multiTopicWorkflow, { args: [count] });

    const aItems = await collectItems(handle, ['a'], 0, 3);
    t.is(aItems[0]!.offset, 0);
    t.is(aItems[1]!.offset, 3);
    t.is(aItems[2]!.offset, 6);

    const bItems = await collectItems(handle, ['b'], 0, 3);
    t.is(bItems[0]!.offset, 1);
    t.is(bItems[1]!.offset, 4);
    t.is(bItems[2]!.offset, 7);

    await handle.signal('close');
  });
});

test('per_item_offsets_after_truncation — offsets remain correct after truncate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateSignalWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    await new Promise((r) => setTimeout(r, 500));

    await handle.signal('truncate', 3);
    await new Promise((r) => setTimeout(r, 300));

    const after = await collectItems(handle, undefined, 3, 2);
    t.is(after.length, 2);
    t.is(after[0]!.offset, 3);
    t.is(after[1]!.offset, 4);

    await handle.signal('close');
  });
});

test('poll_truncated_offset_returns_application_failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateSignalWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    await new Promise((r) => setTimeout(r, 500));
    await handle.signal('truncate', 3);
    await new Promise((r) => setTimeout(r, 300));

    // Poll from offset 1 (truncated) via the raw update — must raise
    // WorkflowUpdateFailedError with ApplicationFailure cause, type
    // 'TruncatedOffset'.
    const rawHandle = env.client.workflow.getHandle(handle.workflowId);
    const err = (await t.throwsAsync(
      rawHandle.executeUpdate<PollResult, [PollInput]>(pubsubPollUpdate, {
        args: [{ topics: [], from_offset: 1 }],
      }),
      { instanceOf: WorkflowUpdateFailedError }
    )) as WorkflowUpdateFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is((err.cause as ApplicationFailure).type, 'TruncatedOffset');

    // Workflow is still usable.
    const after = await collectItems(handle, undefined, 3, 2);
    t.is(after.length, 2);
    t.is(after[0]!.offset, 3);

    await handle.signal('close');
  });
});

test('poll_offset_zero_after_truncation — offset=0 reads from base', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateSignalWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    await new Promise((r) => setTimeout(r, 500));
    await handle.signal('truncate', 3);
    await new Promise((r) => setTimeout(r, 300));

    const after = await collectItems(handle, undefined, 0, 2);
    t.is(after.length, 2);
    t.is(after[0]!.offset, 3);
    t.is(after[1]!.offset, 4);

    await handle.signal('close');
  });
});

test('subscribe_recovers_from_truncation — client auto-restarts from 0', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateSignalWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    await new Promise((r) => setTimeout(r, 500));
    await handle.signal('truncate', 3);
    await new Promise((r) => setTimeout(r, 300));

    // subscribe() from offset 1 (truncated) — client should recover and
    // deliver items from baseOffset (3) onward.
    const received = await collectItems(handle, undefined, 1, 2);
    t.is(received.length, 2);
    t.is(received[0]!.offset, 3);

    await handle.signal('close');
  });
});

test('priority_flush — priority wakes flusher despite 60s interval', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: pubsubActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(priorityWorkflow, { args: [] });
    const items = await collectItems(handle, undefined, 0, 3, 10_000);
    t.is(items.length, 3);
    t.is(decoder.decode(items[2]!.data), 'priority');
    await handle.signal('close');
  });
});

test('dispose_flushes_on_exit — await using drains buffer', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const count = 5;
  const worker = await createWorker({ activities: pubsubActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(flushOnExitWorkflow, { args: [count] });
    const items = await collectItems(handle, undefined, 0, count, 15_000);
    t.is(items.length, count);
    for (let i = 0; i < count; i++) {
      t.is(decoder.decode(items[i]!.data), `item-${i}`);
    }
    await handle.signal('close');
  });
});

test('max_batch_size — triggers flush without waiting for timer', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const count = 7;
  const worker = await createWorker({ activities: pubsubActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(maxBatchWorkflow, { args: [count] });
    const items = await collectItems(handle, undefined, 0, count + 1, 15_000);
    t.is(items.length, count + 1);
    for (let i = 0; i < count; i++) {
      t.is(decoder.decode(items[i]!.data), `item-${i}`);
    }
    await handle.signal('close');
  });
});

test('dedup_rejects_duplicate_signal — same publisher+sequence is dropped', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicPubSubWorkflow, { args: [] });

    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'item-0')],
      publisher_id: 'test-pub',
      sequence: 1,
    });
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'duplicate')],
      publisher_id: 'test-pub',
      sequence: 1,
    });
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'item-1')],
      publisher_id: 'test-pub',
      sequence: 2,
    });
    await new Promise((r) => setTimeout(r, 500));

    const items = await collectItems(handle, undefined, 0, 2);
    t.is(items.length, 2);
    t.is(decoder.decode(items[0]!.data), 'item-0');
    t.is(decoder.decode(items[1]!.data), 'item-1');

    const offset = await handle.query<number>(pubsubOffsetQuery);
    t.is(offset, 2);

    await handle.signal('close');
  });
});

test('retry_timeout_sequence_reuse_causes_data_loss — regression for the fix', async (t) => {
  // This exercises the workflow-side dedup behavior that the client fix
  // protects against. Step 3 verifies that reusing a sequence silently
  // drops the batch (the bug), Step 4 verifies that a fresh sequence is
  // accepted (what the fix produces).
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicPubSubWorkflow, { args: [] });

    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'batch-A')],
      publisher_id: 'victim',
      sequence: 1,
    });
    await new Promise((r) => setTimeout(r, 300));

    const firstItems = await collectItems(handle, undefined, 0, 1);
    t.is(firstItems.length, 1);
    t.is(decoder.decode(firstItems[0]!.data), 'batch-A');

    // Reused sequence (the bug) — batch silently deduped.
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'batch-B')],
      publisher_id: 'victim',
      sequence: 1,
    });
    await new Promise((r) => setTimeout(r, 300));

    const offsetAfterBug = await handle.query<number>(pubsubOffsetQuery);
    t.is(offsetAfterBug, 1, 'batch-B should be silently deduped without the fix');

    // Fresh sequence (what the fix produces) — batch accepted.
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'batch-B-fixed')],
      publisher_id: 'victim',
      sequence: 2,
    });
    await new Promise((r) => setTimeout(r, 300));

    const offsetAfterFix = await handle.query<number>(pubsubOffsetQuery);
    t.is(offsetAfterFix, 2, 'fresh sequence is accepted');

    await handle.signal('close');
  });
});

test('truncate_pubsub — truncate discards prefix and adjusts base', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateSignalWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    await new Promise((r) => setTimeout(r, 500));

    const first = await collectItems(handle, undefined, 0, 5);
    t.is(first.length, 5);

    await handle.signal('truncate', 3);
    await new Promise((r) => setTimeout(r, 300));

    const offset = await handle.query<number>(pubsubOffsetQuery);
    t.is(offset, 5);

    const after = await collectItems(handle, undefined, 3, 2);
    t.is(after.length, 2);
    t.is(decoder.decode(after[0]!.data), 'item-3');
    t.is(decoder.decode(after[1]!.data), 'item-4');

    await handle.signal('close');
  });
});

test('ttl_pruning_in_get_state — TTL=0 prunes, long TTL retains', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(ttlTestWorkflow, { args: [] });

    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'from-a')],
      publisher_id: 'pub-a',
      sequence: 1,
    });
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'from-b')],
      publisher_id: 'pub-b',
      sequence: 1,
    });
    await new Promise((r) => setTimeout(r, 500));

    const kept = await handle.query<PubSubState, [number]>(getStateWithTtlQuery, 9999);
    t.true('pub-a' in kept.publisher_sequences);
    t.true('pub-b' in kept.publisher_sequences);

    const pruned = await handle.query<PubSubState, [number]>(getStateWithTtlQuery, 0);
    t.false('pub-a' in pruned.publisher_sequences);
    t.false('pub-b' in pruned.publisher_sequences);
    t.is(pruned.log.length, 2);

    await handle.signal('close');
  });
});

test('continue_as_new_typed — pubsub state survives CAN', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const workflowId = `pubsub-can-${randomUUID()}`;
    const handle = await startWorkflow(continueAsNewTypedWorkflow, {
      args: [{}],
      workflowId,
    });

    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [
        entry('events', 'item-0'),
        entry('events', 'item-1'),
        entry('events', 'item-2'),
      ],
      publisher_id: '',
      sequence: 0,
    });

    const before = await collectItems(handle, undefined, 0, 3);
    t.is(before.length, 3);

    await handle.signal('triggerContinue');

    // Wait for CAN to land — run-id on a fresh handle differs from the old run.
    const deadline = Date.now() + 10_000;
    let newRunId: string | undefined;
    while (Date.now() < deadline) {
      const fresh = env.client.workflow.getHandle(workflowId);
      const desc = await fresh.describe();
      if (desc.runId !== handle.firstExecutionRunId) {
        newRunId = desc.runId;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    t.truthy(newRunId, 'continue-as-new should produce a new run id');

    const newHandle = env.client.workflow.getHandle(workflowId);
    const afterItems = await collectItems(newHandle, undefined, 0, 3);
    t.is(afterItems.length, 3);
    t.is(decoder.decode(afterItems[0]!.data), 'item-0');

    await newHandle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: [entry('events', 'item-3')],
      publisher_id: '',
      sequence: 0,
    });
    const finalItems = await collectItems(newHandle, undefined, 0, 4);
    t.is(finalItems.length, 4);
    t.is(decoder.decode(finalItems[3]!.data), 'item-3');

    await newHandle.signal('close');
  });
});

test('poll_more_ready_when_response_exceeds_size_limit — 1MB cap', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicPubSubWorkflow, { args: [] });

    const chunk = new Uint8Array(200_000).fill('x'.charCodeAt(0));
    for (let i = 0; i < 8; i++) {
      await handle.signal<[PublishInput]>(pubsubPublishSignal, {
        items: [{ topic: 'big', data: encodeData(chunk) }],
        publisher_id: '',
        sequence: 0,
      });
    }
    await new Promise((r) => setTimeout(r, 500));

    const rawHandle = env.client.workflow.getHandle(handle.workflowId);
    const first = await rawHandle.executeUpdate<PollResult, [PollInput]>(pubsubPollUpdate, {
      args: [{ topics: [], from_offset: 0 }],
    });
    t.is(first.more_ready, true);
    t.true(first.items.length < 8);
    t.true(first.next_offset < 8);

    // Drain the rest.
    let gathered = first.items.length;
    let offset = first.next_offset;
    while (gathered < 8) {
      const next = await rawHandle.executeUpdate<PollResult, [PollInput]>(pubsubPollUpdate, {
        args: [{ topics: [], from_offset: offset }],
      });
      gathered += next.items.length;
      offset = next.next_offset;
    }
    t.is(gathered, 8);

    await handle.signal('close');
  });
});

test('subscribe_iterates_through_more_ready — caller sees all items', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicPubSubWorkflow, { args: [] });
    const chunk = new Uint8Array(200_000).fill('x'.charCodeAt(0));
    for (let i = 0; i < 8; i++) {
      await handle.signal<[PublishInput]>(pubsubPublishSignal, {
        items: [{ topic: 'big', data: encodeData(chunk) }],
        publisher_id: '',
        sequence: 0,
      });
    }
    const items = await collectItems(handle, undefined, 0, 8, 15_000);
    t.is(items.length, 8);
    for (const item of items) {
      t.is(item.data.length, chunk.length);
    }
    await handle.signal('close');
  });
});

test('flush_timeout_surfaces_on_stop — dropped batches are never silent', async (t) => {
  // Point a client at a non-existent workflow so every signal fails, then
  // shrink maxRetryDuration to a value the flusher can exceed between ticks.
  // After stop(), the FlushTimeoutError must propagate (rather than being
  // swallowed by the background loop).
  const { env } = t.context;
  const bogus = env.client.workflow.getHandle(`no-such-workflow-${randomUUID()}`);
  const client = new PubSubClient(bogus, { batchInterval: 0.1, maxRetryDuration: 0.2 });
  client.start();
  client.publish('events', encoder.encode('will-be-lost'));
  // Give the flusher enough ticks to hit retry timeout.
  await new Promise((r) => setTimeout(r, 1500));
  await t.throwsAsync(client.stop(), { instanceOf: FlushTimeoutError });
});

test('small_response_more_ready_false — tiny payloads fit in one poll', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicPubSubWorkflow, { args: [] });

    const smallBatch: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) smallBatch.push(entry('small', 'tiny'));
    await handle.signal<[PublishInput]>(pubsubPublishSignal, {
      items: smallBatch,
      publisher_id: '',
      sequence: 0,
    });
    await new Promise((r) => setTimeout(r, 500));

    const rawHandle = env.client.workflow.getHandle(handle.workflowId);
    const result = await rawHandle.executeUpdate<PollResult, [PollInput]>(pubsubPollUpdate, {
      args: [{ topics: [], from_offset: 0 }],
    });
    t.is(result.more_ready, false);
    t.is(result.items.length, 5);
    t.is(result.next_offset, 5);

    await handle.signal('close');
  });
});
