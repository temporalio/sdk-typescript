/**
 * Test workflows for @temporalio/contrib-workflow-stream.
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
import { WorkflowStream, type WorkflowStreamState } from '@temporalio/contrib-workflow-stream';
import type * as activities from '../activities/contrib-workflow-stream';

const { publishItems, publishMultiTopic, publishWithForceFlush, publishBatchTest, publishWithMaxBatch } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '30 seconds',
    heartbeatTimeout: '10 seconds',
  });

export const closeSignal = defineSignal('close');
export const triggerContinueSignal = defineSignal('triggerContinue');
export const truncateUpdate = defineUpdate<void, [number]>('truncate');
export const getStateWithTtlQuery = defineQuery<WorkflowStreamState, [number]>('getStateWithTtl');
export const publisherSequencesQuery = defineQuery<Record<string, number>>('publisherSequences');

/** A minimal stream-host workflow — initializes WorkflowStream and waits for close. */
export async function basicWorkflowStreamWorkflow(): Promise<void> {
  new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await condition(() => closed);
}

/** Publishes `count` items directly from the workflow, then waits. */
export async function workflowSidePublishWorkflow(count: number): Promise<void> {
  const stream = new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  const encoder = new TextEncoder();
  for (let i = 0; i < count; i++) {
    stream.publish('events', encoder.encode(`item-${i}`));
  }
  await condition(() => closed);
}

/** Executes publishMultiTopic activity then waits. */
export async function multiTopicWorkflow(count: number): Promise<void> {
  new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishMultiTopic(count);
  await condition(() => closed);
}

/** Executes publishItems activity then appends activity_done status. */
export async function activityPublishWorkflow(count: number): Promise<void> {
  const stream = new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishItems(count);
  stream.publish('status', new TextEncoder().encode('activity_done'));
  await condition(() => closed);
}

/** Workflow that accepts a truncate update (explicit completion). */
export async function truncateWorkflow(): Promise<void> {
  const stream = new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(truncateUpdate, (upToOffset: number) => {
    stream.truncate(upToOffset);
  });
  await condition(() => closed);
}

/** Workflow that exposes getState via query for TTL testing. */
export async function ttlTestWorkflow(): Promise<void> {
  const stream = new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(getStateWithTtlQuery, (ttl: number) => stream.getState(ttl));
  await condition(() => closed);
}

/** Workflow that runs publishWithForceFlush activity. */
export async function forceFlushWorkflow(): Promise<void> {
  new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishWithForceFlush();
  await condition(() => closed);
}

/** Workflow that runs publishBatchTest activity. */
export async function flushOnExitWorkflow(count: number): Promise<void> {
  new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishBatchTest(count);
  await condition(() => closed);
}

/** Workflow that runs publishWithMaxBatch activity. */
export async function maxBatchWorkflow(count: number): Promise<void> {
  const stream = new WorkflowStream();
  let closed = false;
  setHandler(closeSignal, () => {
    closed = true;
  });
  await publishWithMaxBatch(count);
  stream.publish('status', new TextEncoder().encode('activity_done'));
  await condition(() => closed);
}

/** Typed input for the continue-as-new workflow. */
export interface CANWorkflowInput {
  streamState?: WorkflowStreamState;
}

/** CAN workflow using properly-typed streamState (explicit recipe). */
export async function continueAsNewTypedWorkflow(input: CANWorkflowInput): Promise<void> {
  const stream = new WorkflowStream(input.streamState);
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
  setHandler(publisherSequencesQuery, () => stream.getState(Number.MAX_SAFE_INTEGER).publisher_sequences);
  await condition(() => shouldContinue || closed);
  if (closed) return;
  stream.drain();
  await continueAsNew<typeof continueAsNewTypedWorkflow>({
    streamState: stream.getState(),
  });
}

/** CAN workflow that uses the packaged `WorkflowStream.continueAsNew` helper. */
export async function continueAsNewHelperWorkflow(input: CANWorkflowInput): Promise<void> {
  const stream = new WorkflowStream(input.streamState);
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
  await stream.continueAsNew<typeof continueAsNewHelperWorkflow>((state) => [
    { streamState: state },
  ]);
}
