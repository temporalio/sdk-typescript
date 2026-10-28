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
