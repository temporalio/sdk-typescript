/**
 * Test activities for @temporalio/contrib-pubsub.
 *
 * These activities use `PubSubClient.fromActivity()` to target the
 * current activity's parent workflow from the activity context.
 */

import { Context } from '@temporalio/activity';
import { PubSubClient } from '@temporalio/contrib-pubsub';

const encoder = new TextEncoder();

export async function publishItems(count: number): Promise<void> {
  await using client = PubSubClient.fromActivity({ batchInterval: 0.5 });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    client.publish('events', encoder.encode(`item-${i}`));
  }
}

export async function publishMultiTopic(count: number): Promise<void> {
  const topics = ['a', 'b', 'c'];
  await using client = PubSubClient.fromActivity({ batchInterval: 0.5 });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    const topic = topics[i % topics.length]!;
    client.publish(topic, encoder.encode(`${topic}-${i}`));
  }
}

export async function publishWithForceFlush(): Promise<void> {
  // Long batchInterval AND long post-publish hold ensure that only a
  // working forceFlush wakeup can deliver items before dispose flushes.
  // The hold is deliberately much longer than the test's collect timeout
  // so a regression (forceFlush no-op) surfaces as a missing item rather
  // than flaking on slow CI.
  await using client = PubSubClient.fromActivity({ batchInterval: 60.0 });
  client.start();
  client.publish('events', encoder.encode('normal-0'));
  client.publish('events', encoder.encode('normal-1'));
  client.publish('events', encoder.encode('force-flush'), true);
  for (let i = 0; i < 100; i++) {
    Context.current().heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function publishBatchTest(count: number): Promise<void> {
  await using client = PubSubClient.fromActivity({ batchInterval: 60.0 });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    client.publish('events', encoder.encode(`item-${i}`));
  }
  // Long batchInterval — only the dispose-driven drain will flush.
}

export async function publishWithMaxBatch(count: number): Promise<void> {
  await using client = PubSubClient.fromActivity({
    batchInterval: 60.0,
    maxBatchSize: 3,
  });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    client.publish('events', encoder.encode(`item-${i}`));
  }
  // Long batchInterval — maxBatchSize and dispose-driven drain handle flushing.
}
