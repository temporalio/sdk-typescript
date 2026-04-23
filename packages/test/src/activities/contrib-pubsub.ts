/**
 * Test activities for @temporalio/contrib-pubsub.
 *
 * These activities use `PubSubClient.create()` with no arguments, relying on
 * the activity context to supply the client and workflow ID.
 */

import { Context } from '@temporalio/activity';
import { PubSubClient } from '@temporalio/contrib-pubsub';

const encoder = new TextEncoder();

export async function publishItems(count: number): Promise<void> {
  await using client = PubSubClient.create(undefined, undefined, { batchInterval: 0.5 });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    client.publish('events', encoder.encode(`item-${i}`));
  }
}

export async function publishMultiTopic(count: number): Promise<void> {
  const topics = ['a', 'b', 'c'];
  await using client = PubSubClient.create(undefined, undefined, { batchInterval: 0.5 });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    const topic = topics[i % topics.length]!;
    client.publish(topic, encoder.encode(`${topic}-${i}`));
  }
}

export async function publishWithPriority(): Promise<void> {
  await using client = PubSubClient.create(undefined, undefined, { batchInterval: 60.0 });
  client.start();
  client.publish('events', encoder.encode('normal-0'));
  client.publish('events', encoder.encode('normal-1'));
  client.publish('events', encoder.encode('priority'), true);
  // Give the flusher time to wake and flush.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function publishBatchTest(count: number): Promise<void> {
  await using client = PubSubClient.create(undefined, undefined, { batchInterval: 60.0 });
  client.start();
  for (let i = 0; i < count; i++) {
    Context.current().heartbeat();
    client.publish('events', encoder.encode(`item-${i}`));
  }
  // Long batchInterval — only the dispose-driven drain will flush.
}

export async function publishWithMaxBatch(count: number): Promise<void> {
  await using client = PubSubClient.create(undefined, undefined, {
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
