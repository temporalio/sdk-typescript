/**
 * Test workflows for @temporalio/contrib-pubsub.
 */

import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import { PubSub, type PubSubState } from '@temporalio/contrib-pubsub';
import type * as activities from '../activities/contrib-pubsub';

const { publishItems, publishMultiTopic, publishWithForceFlush, publishBatchTest, publishWithMaxBatch } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '30 seconds',
    heartbeatTimeout: '10 seconds',
  });

export const closeSignal = defineSignal('close');
export const triggerContinueSignal = defineSignal('triggerContinue');
export const truncateUpdate = defineUpdate<void, [number]>('truncate');
export const getStateWithTtlQuery = defineQuery<PubSubState, [number]>('getStateWithTtl');
export const publisherSequencesQuery = defineQuery<Record<string, number>>('publisherSequences');

/** A minimal broker workflow — initializes pub/sub and waits for close. */
export async function basicPubSubWorkflow(): Promise<void> {
  new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await condition(() => closed);
}

/** Publishes `count` items directly from the workflow, then waits. */
export async function workflowSidePublishWorkflow(count: number): Promise<void> {
  const pubsub = new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  const encoder = new TextEncoder();
  for (let i = 0; i < count; i++) {
    pubsub.publish('events', encoder.encode(`item-${i}`));
  }
  await condition(() => closed);
}

/** Executes publishMultiTopic activity then waits. */
export async function multiTopicWorkflow(count: number): Promise<void> {
  new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishMultiTopic(count);
  await condition(() => closed);
}

/** Executes publishItems activity then appends activity_done status. */
export async function activityPublishWorkflow(count: number): Promise<void> {
  const pubsub = new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishItems(count);
  pubsub.publish('status', new TextEncoder().encode('activity_done'));
  await condition(() => closed);
}

/** Workflow that accepts a truncate update (explicit completion). */
export async function truncateWorkflow(): Promise<void> {
  const pubsub = new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(truncateUpdate, (upToOffset: number) => {
    pubsub.truncate(upToOffset);
  });
  await condition(() => closed);
}

/** Workflow that exposes getState via query for TTL testing. */
export async function ttlTestWorkflow(): Promise<void> {
  const pubsub = new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(getStateWithTtlQuery, (ttl: number) => pubsub.getState(ttl));
  await condition(() => closed);
}

/** Workflow that runs publishWithForceFlush activity. */
export async function forceFlushWorkflow(): Promise<void> {
  new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishWithForceFlush();
  await condition(() => closed);
}

/** Workflow that runs publishBatchTest activity. */
export async function flushOnExitWorkflow(count: number): Promise<void> {
  new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishBatchTest(count);
  await condition(() => closed);
}

/** Workflow that runs publishWithMaxBatch activity. */
export async function maxBatchWorkflow(count: number): Promise<void> {
  const pubsub = new PubSub();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishWithMaxBatch(count);
  pubsub.publish('status', new TextEncoder().encode('activity_done'));
  await condition(() => closed);
}

/** Typed input for the continue-as-new workflow. */
export interface CANWorkflowInput {
  pubsubState?: PubSubState;
}

/** CAN workflow using properly-typed pubsubState (explicit recipe). */
export async function continueAsNewTypedWorkflow(input: CANWorkflowInput): Promise<void> {
  const pubsub = new PubSub(input.pubsubState);
  let closed = false;
  let shouldContinue = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(triggerContinueSignal, () => {
    shouldContinue = true;
  });
  // Expose publisher_sequences for CAN dedup-survival test. Use a very
  // large TTL so we read the current state without pruning.
  setHandler(publisherSequencesQuery, () => pubsub.getState(Number.MAX_SAFE_INTEGER).publisher_sequences);
  await condition(() => shouldContinue || closed);
  if (closed) return;
  pubsub.drain();
  await continueAsNew<typeof continueAsNewTypedWorkflow>({
    pubsubState: pubsub.getState(),
  });
}

/** CAN workflow that uses the packaged `PubSub.continueAsNew` helper. */
export async function continueAsNewHelperWorkflow(input: CANWorkflowInput): Promise<void> {
  const pubsub = new PubSub(input.pubsubState);
  let closed = false;
  let shouldContinue = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(triggerContinueSignal, () => {
    shouldContinue = true;
  });
  await condition(() => shouldContinue || closed);
  if (closed) return;
  await pubsub.continueAsNew<typeof continueAsNewHelperWorkflow>((state) => [
    { pubsubState: state },
  ]);
}
