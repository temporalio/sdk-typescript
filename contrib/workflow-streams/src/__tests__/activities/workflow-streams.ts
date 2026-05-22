/**
 * Test activities for @temporalio/workflow-streams.
 *
 * These activities use `WorkflowStreamClient.fromWithinActivity()` to target the
 * current activity's parent workflow from the activity context.
 */

import { Context } from '@temporalio/activity';
import { WorkflowStreamClient } from '../../client';

export async function publishItems(count: number): Promise<void> {
  await using client = WorkflowStreamClient.fromWithinActivity({ batchInterval: '500 milliseconds' });
  const events = client.topic('events');
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    events.publish(`item-${i}`);
  }
}

/** Publishes `count` items as `Uint8Array` — exercises the binary/plain encoding path. */
export async function publishBinaryItems(count: number): Promise<void> {
  const encoder = new TextEncoder();
  await using client = WorkflowStreamClient.fromWithinActivity({ batchInterval: '500 milliseconds' });
  const events = client.topic('events');
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    events.publish(encoder.encode(`item-${i}`));
  }
}

export async function publishMultiTopic(count: number): Promise<void> {
  const topicNames = ['a', 'b', 'c'];
  await using client = WorkflowStreamClient.fromWithinActivity({ batchInterval: '500 milliseconds' });
  const handles = topicNames.map((name) => client.topic<string>(name));
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    const idx = i % handles.length;
    handles[idx]!.publish(`${topicNames[idx]}-${i}`);
  }
}

export async function publishWithForceFlush(): Promise<void> {
  // Long batchInterval AND long post-publish hold ensure that only a
  // working forceFlush wakeup can deliver items before dispose flushes.
  // The hold is deliberately much longer than the test's collect timeout
  // so a regression (forceFlush no-op) surfaces as a missing item rather
  // than flaking on slow CI.
  await using client = WorkflowStreamClient.fromWithinActivity({ batchInterval: '60 seconds' });
  const events = client.topic<string>('events');
  events.publish('normal-0');
  events.publish('normal-1');
  events.publish('force-flush', { forceFlush: true });
  for (let i = 0; i < 100; i++) {
    Context.current().heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function publishBatchTest(count: number): Promise<void> {
  await using client = WorkflowStreamClient.fromWithinActivity({ batchInterval: '60 seconds' });
  const events = client.topic<string>('events');
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    events.publish(`item-${i}`);
  }
  // Long batchInterval — only the dispose-driven drain will flush.
}

export async function publishWithMaxBatch(count: number): Promise<void> {
  await using client = WorkflowStreamClient.fromWithinActivity({
    batchInterval: '60 seconds',
    maxBatchSize: 3,
  });
  const events = client.topic<string>('events');
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    events.publish(`item-${i}`);
  }
  // Long batchInterval — maxBatchSize and dispose-driven drain handle flushing.
}
