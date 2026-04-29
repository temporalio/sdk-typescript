/**
 * E2E integration tests for @temporalio/contrib-workflow-stream.
 *
 * Ported from sdk-python tests/contrib/stream/test_stream.py.
 */

import { randomUUID } from 'crypto';
import { ApplicationFailure, defaultPayloadConverter, type Payload } from '@temporalio/common';
import { WorkflowHandle, WorkflowUpdateFailedError } from '@temporalio/client';
import {
  FlushTimeoutError,
  WorkflowStreamClient,
  type PollInput,
  type PollResult,
  type WorkflowStreamItem,
  type WorkflowStreamState,
  type PublishEntry,
  type PublishInput,
  encodePayloadWire,
  workflowStreamOffsetQuery,
  workflowStreamPublishSignal,
  workflowStreamPollUpdate,
} from '@temporalio/contrib-workflow-stream';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  activityPublishWorkflow,
  basicWorkflowStreamWorkflow,
  continueAsNewHelperWorkflow,
  continueAsNewTypedWorkflow,
  flushOnExitWorkflow,
  getStateWithTtlQuery,
  maxBatchWorkflow,
  multiTopicWorkflow,
  forceFlushWorkflow,
  publisherSequencesQuery,
  truncateUpdate,
  truncateWorkflow,
  ttlTestWorkflow,
  workflowSidePublishWorkflow,
} from './workflows/contrib-workflow-stream';
import * as streamActivities from './activities/contrib-workflow-stream';

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/contrib-workflow-stream'),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build a `PublishEntry` for a literal string.
 *
 * Mirrors what `WorkflowStreamClient` produces on the encode path: the default
 * payload converter wraps the bytes into a `Payload`, which is then
 * proto-serialized and base64-encoded for the wire.
 */
function entry(topic: string, data: string): PublishEntry {
  const payload = defaultPayloadConverter.toPayload(encoder.encode(data));
  return { topic, data: encodePayloadWire(payload) };
}

/** Extract the raw bytes from a `Payload` produced by the default converter. */
function payloadBytes(payload: Payload): Uint8Array {
  // defaultPayloadConverter maps Uint8Array to encoding=binary/plain, so
  // `data` is already the raw bytes. For string/JSON payloads we fall back
  // to the converter.
  const encoding = payload.metadata?.['encoding'];
  if (encoding && decoder.decode(encoding) === 'binary/plain') {
    return payload.data ?? new Uint8Array(0);
  }
  return defaultPayloadConverter.fromPayload<Uint8Array>(payload);
}

function payloadString(payload: Payload): string {
  return decoder.decode(payloadBytes(payload));
}

async function collectItems(
  handle: WorkflowHandle,
  topics: string[] | undefined,
  fromOffset: number,
  expectedCount: number,
  timeoutMs = 15_000
): Promise<WorkflowStreamItem[]> {
  const client = new WorkflowStreamClient(handle);
  const items: WorkflowStreamItem[] = [];
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
  const worker = await createWorker({ activities: streamActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(activityPublishWorkflow, { args: [count] });
    const items = await collectItems(handle, undefined, 0, count + 1);
    t.is(items.length, count + 1);
    for (let i = 0; i < count; i++) {
      t.is(items[i]!.topic, 'events');
      t.is(payloadString(items[i]!.data), `item-${i}`);
    }
    t.is(items[count]!.topic, 'status');
    t.is(payloadString(items[count]!.data), 'activity_done');
    await handle.signal('close');
  });
});

test('topic_filtering — subscriber gets only requested topics', async (t) => {
  const count = 9;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: streamActivities });
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

test('subscribe_from_offset_and_per_item_offsets — non-zero starts and global offsets', async (t) => {
  const count = 5;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(workflowSidePublishWorkflow, { args: [count] });

    // From offset 0 — all items, offsets 0..count-1.
    const allItems = await collectItems(handle, undefined, 0, count);
    t.is(allItems.length, count);
    for (let i = 0; i < count; i++) {
      t.is(allItems[i]!.offset, i);
      t.is(payloadString(allItems[i]!.data), `item-${i}`);
    }

    // From offset 3 — items 3, 4 with offsets 3, 4.
    const laterItems = await collectItems(handle, undefined, 3, 2);
    t.is(laterItems.length, 2);
    t.is(laterItems[0]!.offset, 3);
    t.is(payloadString(laterItems[0]!.data), 'item-3');
    t.is(laterItems[1]!.offset, 4);
    t.is(payloadString(laterItems[1]!.data), 'item-4');

    await handle.signal('close');
  });
});

test('per_item_offsets_with_topic_filter — offsets are global, not per-topic', async (t) => {
  const count = 9;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: streamActivities });
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

test('poll_truncated_offset_returns_application_failure', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    // Truncate via update — completion is explicit.
    await handle.executeUpdate(truncateUpdate, { args: [3] });

    // Poll from offset 1 (truncated) must raise WorkflowUpdateFailedError
    // with ApplicationFailure cause of type 'TruncatedOffset'.
    const rawHandle = env.client.workflow.getHandle(handle.workflowId);
    const err = (await t.throwsAsync(
      rawHandle.executeUpdate<PollResult, [PollInput]>(workflowStreamPollUpdate, {
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

test('subscribe_recovers_from_truncation — client auto-restarts from 0', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });
    // Truncate via update — explicit completion.
    await handle.executeUpdate(truncateUpdate, { args: [3] });

    // subscribe() from offset 1 (truncated) — client should recover and
    // deliver items from baseOffset (3) onward.
    const received = await collectItems(handle, undefined, 1, 2);
    t.is(received.length, 2);
    t.is(received[0]!.offset, 3);

    await handle.signal('close');
  });
});

test('force_flush — forceFlush wakes flusher despite 60s interval', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: streamActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(forceFlushWorkflow, { args: [] });
    // The activity holds for ~10s after the forceFlush publish; 5s timeout
    // gives plenty of margin for scheduling while staying well below the
    // hold so a regression (no forceFlush wakeup) surfaces as a missing
    // item, not a pass via the dispose-driven flush at activity exit.
    const items = await collectItems(handle, undefined, 0, 3, 5_000);
    t.is(items.length, 3);
    t.is(payloadString(items[2]!.data), 'force-flush');
    await handle.signal('close');
  });
});

test('dispose_flushes_on_exit — await using drains buffer', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const count = 5;
  const worker = await createWorker({ activities: streamActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(flushOnExitWorkflow, { args: [count] });
    const items = await collectItems(handle, undefined, 0, count, 15_000);
    t.is(items.length, count);
    for (let i = 0; i < count; i++) {
      t.is(payloadString(items[i]!.data), `item-${i}`);
    }
    await handle.signal('close');
  });
});

test('max_batch_size — triggers flush without waiting for timer', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const count = 7;
  const worker = await createWorker({ activities: streamActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(maxBatchWorkflow, { args: [count] });
    const items = await collectItems(handle, undefined, 0, count + 1, 15_000);
    t.is(items.length, count + 1);
    for (let i = 0; i < count; i++) {
      t.is(payloadString(items[i]!.data), `item-${i}`);
    }
    await handle.signal('close');
  });
});

test('dedup_rejects_duplicate_signal — same publisher+sequence is dropped', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicWorkflowStreamWorkflow, { args: [] });

    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'item-0')],
      publisher_id: 'test-pub',
      sequence: 1,
    });
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'duplicate')],
      publisher_id: 'test-pub',
      sequence: 1,
    });
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'item-1')],
      publisher_id: 'test-pub',
      sequence: 2,
    });

    // collectItems' update call acts as a barrier — prior signals processed.
    const items = await collectItems(handle, undefined, 0, 2);
    t.is(items.length, 2);
    t.is(payloadString(items[0]!.data), 'item-0');
    t.is(payloadString(items[1]!.data), 'item-1');

    const offset = await handle.query<number>(workflowStreamOffsetQuery);
    t.is(offset, 2);

    await handle.signal('close');
  });
});

test('truncate_stream — truncate discards prefix and adjusts base', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 5; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });

    const first = await collectItems(handle, undefined, 0, 5);
    t.is(first.length, 5);

    // Truncate via update — returns after the handler completes.
    await handle.executeUpdate(truncateUpdate, { args: [3] });

    // Offset should still be 5 (truncation moves base_offset, not tail).
    const offset = await handle.query<number>(workflowStreamOffsetQuery);
    t.is(offset, 5);

    const after = await collectItems(handle, undefined, 3, 2);
    t.is(after.length, 2);
    t.is(payloadString(after[0]!.data), 'item-3');
    t.is(payloadString(after[1]!.data), 'item-4');

    await handle.signal('close');
  });
});

test('truncate_past_end_raises_application_failure', async (t) => {
  // truncate() with an offset past the end of the log surfaces as
  // WorkflowUpdateFailedError with cause type 'TruncateOutOfRange'.
  // The workflow task must not be poisoned: a follow-up poll still works.
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(truncateWorkflow, { args: [] });

    const items: PublishEntry[] = [];
    for (let i = 0; i < 2; i++) items.push(entry('events', `item-${i}`));
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items,
      publisher_id: '',
      sequence: 0,
    });

    // Only 2 items exist; asking to truncate to offset 5 is out of range.
    const err = (await t.throwsAsync(handle.executeUpdate(truncateUpdate, { args: [5] }), {
      instanceOf: WorkflowUpdateFailedError,
    })) as WorkflowUpdateFailedError;
    t.true(err.cause instanceof ApplicationFailure);
    t.is((err.cause as ApplicationFailure).type, 'TruncateOutOfRange');

    // Workflow task wasn't poisoned — a valid poll still completes.
    const after = await collectItems(handle, undefined, 0, 2);
    t.is(after.length, 2);

    await handle.signal('close');
  });
});

test('explicit_flush_barrier — flush() returns once items are confirmed', async (t) => {
  // flush() is a synchronization point. With a 60s batchInterval, a
  // regression that silently relies on the background timer would hang
  // (and miss the per-test timeout) rather than slow-pass.
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicWorkflowStreamWorkflow, { args: [] });

    const stream = new WorkflowStreamClient(handle, { batchInterval: '60 seconds' });

    // 1. Empty-buffer flush is a no-op (must not block).
    t.is(await stream.getOffset(), 0);
    await stream.flush();
    t.is(await stream.getOffset(), 0);

    // 2. Flush makes prior publishes visible without waiting on the
    // 60s batch timer.
    stream.publish('events', encoder.encode('a'));
    stream.publish('events', encoder.encode('b'));
    stream.publish('events', encoder.encode('c'));
    await stream.flush();
    t.is(await stream.getOffset(), 3);

    // 3. Second flush with no new items is a no-op.
    await stream.flush();
    t.is(await stream.getOffset(), 3);

    await handle.signal('close');
  });
});

test('subscribe_accepts_string_topic — single-string convenience', async (t) => {
  // subscribe(topics='a') is equivalent to subscribe(topics=['a']).
  const count = 9;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities: streamActivities });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(multiTopicWorkflow, { args: [count] });

    const client = new WorkflowStreamClient(handle);
    const items: WorkflowStreamItem[] = [];
    const gen = client.subscribe('a', 0, { pollCooldown: 0 });
    for await (const item of gen) {
      items.push(item);
      if (items.length >= 3) {
        await gen.return();
        break;
      }
    }
    t.is(items.length, 3);
    t.true(items.every((it) => it.topic === 'a'));

    await handle.signal('close');
  });
});

test('ttl_pruning_in_get_state — old publisher pruned, new publisher kept', async (t) => {
  // pub-old arrives first, then wall-clock gap, then pub-new. TTL=0.5s
  // prunes pub-old (~1s old) but keeps pub-new (~0s).
  //
  // The gap is generous relative to TTL (1.0s / 0.5s) so the test
  // tolerates multi-hundred-ms scheduling jitter in both directions.
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(ttlTestWorkflow, { args: [] });

    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'old')],
      publisher_id: 'pub-old',
      sequence: 1,
    });

    // Sanity: pub-old is recorded (generous TTL retains it).
    // Generous TTL: 9999 seconds, expressed in ms.
    const before = await handle.query<WorkflowStreamState, [number]>(getStateWithTtlQuery, 9999_000);
    t.true('pub-old' in before.publisher_sequences);

    // Wall-clock gap so workflow.time() advances between the two signals.
    await new Promise((r) => setTimeout(r, 1000));

    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'new')],
      publisher_id: 'pub-new',
      sequence: 1,
    });

    // 500 ms TTL: pub-old (~1s old) is pruned, pub-new (~0s old) is kept.
    const state = await handle.query<WorkflowStreamState, [number]>(getStateWithTtlQuery, 500);
    t.false('pub-old' in state.publisher_sequences);
    t.true('pub-new' in state.publisher_sequences);
    t.is(state.log.length, 2);

    await handle.signal('close');
  });
});

test('continue_as_new_typed — log, offsets, AND dedup state survive CAN', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const workflowId = `stream-can-${randomUUID()}`;
    const handle = await startWorkflow(continueAsNewTypedWorkflow, {
      args: [{}],
      workflowId,
    });

    // Seed publisher dedup state (pub / sequence=1) so we can verify it
    // survives CAN.
    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [
        entry('events', 'item-0'),
        entry('events', 'item-1'),
        entry('events', 'item-2'),
      ],
      publisher_id: 'pub',
      sequence: 1,
    });

    const before = await collectItems(handle, undefined, 0, 3);
    t.is(before.length, 3);

    await handle.signal('triggerContinue');

    // Wait for CAN (new run-id on a fresh handle).
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
    t.truthy(newRunId, 'CAN should produce a new run id');

    const newHandle = env.client.workflow.getHandle(workflowId);

    // Log contents and offsets preserved across CAN.
    const afterItems = await collectItems(newHandle, undefined, 0, 3);
    t.deepEqual(
      afterItems.map((i) => payloadString(i.data)),
      ['item-0', 'item-1', 'item-2']
    );
    t.deepEqual(
      afterItems.map((i) => i.offset),
      [0, 1, 2]
    );

    // Dedup state preserved: publisher_sequences carries {pub: 1} after CAN.
    const seqsAfterCan = await newHandle.query<Record<string, number>>(publisherSequencesQuery);
    t.deepEqual(seqsAfterCan, { pub: 1 });

    // Re-sending publisher_id='pub', sequence=1 must be rejected — log and
    // publisher_sequences unchanged.
    await newHandle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'dup')],
      publisher_id: 'pub',
      sequence: 1,
    });
    const seqsAfterDup = await newHandle.query<Record<string, number>>(publisherSequencesQuery);
    t.deepEqual(seqsAfterDup, { pub: 1 });

    // Fresh sequence from same publisher accepted; item-3 lands at offset 3.
    await newHandle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'item-3')],
      publisher_id: 'pub',
      sequence: 2,
    });
    const seqsAfterAccept = await newHandle.query<Record<string, number>>(publisherSequencesQuery);
    t.deepEqual(seqsAfterAccept, { pub: 2 });

    const finalItems = await collectItems(newHandle, undefined, 0, 4);
    t.deepEqual(
      finalItems.map((i) => payloadString(i.data)),
      ['item-0', 'item-1', 'item-2', 'item-3']
    );
    t.is(finalItems[3]!.offset, 3);

    await newHandle.signal('close');
  });
});

test('continue_as_new_helper — log and offsets survive CAN via WorkflowStream.continueAsNew', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const workflowId = `stream-can-helper-${randomUUID()}`;
    const handle = await startWorkflow(continueAsNewHelperWorkflow, {
      args: [{}],
      workflowId,
    });

    await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
      items: [entry('events', 'item-0'), entry('events', 'item-1')],
      publisher_id: 'pub',
      sequence: 1,
    });

    const before = await collectItems(handle, undefined, 0, 2);
    t.is(before.length, 2);

    await handle.signal('triggerContinue');

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
    t.truthy(newRunId, 'CAN should produce a new run id');

    const newHandle = env.client.workflow.getHandle(workflowId);
    const afterItems = await collectItems(newHandle, undefined, 0, 2);
    t.deepEqual(
      afterItems.map((i) => payloadString(i.data)),
      ['item-0', 'item-1']
    );
    t.deepEqual(
      afterItems.map((i) => i.offset),
      [0, 1]
    );

    await newHandle.signal('close');
  });
});

test('poll_more_ready_when_response_exceeds_size_limit — 1MB cap', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const { env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicWorkflowStreamWorkflow, { args: [] });

    const chunk = new Uint8Array(200_000).fill('x'.charCodeAt(0));
    const chunkPayload = defaultPayloadConverter.toPayload(chunk);
    for (let i = 0; i < 8; i++) {
      await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
        items: [{ topic: 'big', data: encodePayloadWire(chunkPayload) }],
        publisher_id: '',
        sequence: 0,
      });
    }

    // The update acts as a barrier for all prior publish signals.
    const rawHandle = env.client.workflow.getHandle(handle.workflowId);
    const first = await rawHandle.executeUpdate<PollResult, [PollInput]>(workflowStreamPollUpdate, {
      args: [{ topics: [], from_offset: 0 }],
    });
    t.is(first.more_ready, true);
    t.true(first.items.length < 8);
    t.true(first.next_offset < 8);

    // Drain the rest.
    let gathered = first.items.length;
    let offset = first.next_offset;
    let last: PollResult = first;
    while (gathered < 8) {
      last = await rawHandle.executeUpdate<PollResult, [PollInput]>(workflowStreamPollUpdate, {
        args: [{ topics: [], from_offset: offset }],
      });
      gathered += last.items.length;
      offset = last.next_offset;
    }
    t.is(gathered, 8);
    // The final poll that drained the log should set more_ready=false.
    t.is(last.more_ready, false);

    await handle.signal('close');
  });
});

test('subscribe_iterates_through_more_ready — caller sees all items', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicWorkflowStreamWorkflow, { args: [] });
    const chunk = new Uint8Array(200_000).fill('x'.charCodeAt(0));
    const chunkPayload = defaultPayloadConverter.toPayload(chunk);
    for (let i = 0; i < 8; i++) {
      await handle.signal<[PublishInput]>(workflowStreamPublishSignal, {
        items: [{ topic: 'big', data: encodePayloadWire(chunkPayload) }],
        publisher_id: '',
        sequence: 0,
      });
    }
    const items = await collectItems(handle, undefined, 0, 8, 15_000);
    t.is(items.length, 8);
    for (const item of items) {
      t.is(payloadBytes(item.data).length, chunk.length);
    }
    await handle.signal('close');
  });
});

test('flush_retry_preserves_items_after_failures — behavioral retry coverage', async (t) => {
  // Inject signal failures on the handle so the client exercises its retry
  // path. Then let delivery succeed and verify items arrive in publish
  // order, exactly once — no drops, no duplicates, no reorderings.
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(basicWorkflowStreamWorkflow, { args: [] });

    const stream = new WorkflowStreamClient(handle);
    const realSignal = handle.signal.bind(handle);
    let failRemaining = 2;
    (handle as unknown as { signal: typeof handle.signal }).signal = (async (...args: unknown[]) => {
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new Error('simulated delivery failure');
      }
      return realSignal(...(args as Parameters<typeof handle.signal>));
    }) as typeof handle.signal;

    stream.publish('events', encoder.encode('item-0'));
    stream.publish('events', encoder.encode('item-1'));
    await t.throwsAsync((stream as unknown as { _doFlush(): Promise<void> })._doFlush(), {
      message: /simulated/,
    });

    // Publish more during the failed state — must not overtake the pending
    // retry on eventual delivery.
    stream.publish('events', encoder.encode('item-2'));
    await t.throwsAsync((stream as unknown as { _doFlush(): Promise<void> })._doFlush(), {
      message: /simulated/,
    });

    // Third flush delivers the pending retry batch.
    await (stream as unknown as { _doFlush(): Promise<void> })._doFlush();
    // Fourth flush delivers the buffered 'item-2'.
    await (stream as unknown as { _doFlush(): Promise<void> })._doFlush();

    const items = await collectItems(handle, undefined, 0, 3);
    t.deepEqual(
      items.map((i) => payloadString(i.data)),
      ['item-0', 'item-1', 'item-2']
    );

    await handle.signal('close');
  });
});

test('flush_raises_after_max_retry_duration — timeout surfaces, client resumes', async (t) => {
  // When the retry window expires, stop() must rethrow FlushTimeoutError;
  // the client stays usable and subsequent publishes succeed.
  const { env } = t.context;
  const bogus = env.client.workflow.getHandle(`no-such-workflow-${randomUUID()}`);
  const client = new WorkflowStreamClient(bogus, {
    batchInterval: '100 milliseconds',
    maxRetryDuration: '200 milliseconds',
  });
  client.start();
  client.publish('events', encoder.encode('will-be-lost'));
  await new Promise((r) => setTimeout(r, 1500));
  await t.throwsAsync(client.stop(), { instanceOf: FlushTimeoutError });
});

