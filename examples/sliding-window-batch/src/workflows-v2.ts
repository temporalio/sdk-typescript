/**
 * Sliding Window Batch Workflow - Version 2 (Alternative Implementation)
 * 
 * This version uses getExternalWorkflowHandle to signal the parent directly
 * from the child workflow, which is more idiomatic for Temporal TypeScript.
 */
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
  log,
  sleep,
} from '@temporalio/workflow';

import type * as activities from './activities';

// ============================================================================
// Types
// ============================================================================

export interface SlidingWindowInput {
  pageSize: number;
  slidingWindowSize: number;
  offset: number;
  maximumOffset: number;
  progress: number;
  currentRecords: Record<number, boolean>;
}

export interface BatchState {
  currentRecords: number[];
  childrenStartedByThisRun: number;
  offset: number;
  progress: number;
}

export interface RecordItem {
  id: number;
  data: string;
}

// ============================================================================
// Signals and Queries
// ============================================================================

export const completionSignal = defineSignal<[number]>('ReportCompletion');
export const batchStateQuery = defineQuery<BatchState>('state');

// ============================================================================
// Parent Workflow - Sliding Window Coordinator
// ============================================================================

export async function slidingWindowBatch(input: SlidingWindowInput): Promise<number> {
  log.info('SlidingWindowBatch started', { ...input });

  // Proxy activities
  const { fetchRecords } = proxyActivities<typeof activities>({
    startToCloseTimeout: '30 seconds',
  });

  // State
  const currentRecords: Record<number, boolean> = { ...input.currentRecords };
  let offset = input.offset;
  let progress = input.progress;
  const childrenStarted: string[] = [];
  const workflowId = workflowInfo().workflowId;

  // Query handler
  setHandler(batchStateQuery, (): BatchState => ({
    currentRecords: Object.keys(currentRecords).map(Number).sort((a, b) => a - b),
    childrenStartedByThisRun: childrenStarted.length,
    offset,
    progress,
  }));

  // Signal handler for completion notifications from children
  setHandler(completionSignal, (recordId: number) => {
    if (currentRecords[recordId]) {
      delete currentRecords[recordId];
      progress++;
      log.info('Child completed', { recordId, progress, remaining: Object.keys(currentRecords).length });
    }
  });

  // Fetch records for this batch
  let records: RecordItem[] = [];
  if (offset < input.maximumOffset) {
    records = await fetchRecords(offset, input.pageSize, input.maximumOffset);
  }

  // Start child workflows for each record
  for (const record of records) {
    // Wait for window capacity
    await condition(() => Object.keys(currentRecords).length < input.slidingWindowSize);

    const childId = `${workflowId}/record-${record.id}`;
    
    await startChild(processRecord, {
      args: [record, workflowId],
      workflowId: childId,
      parentClosePolicy: 'ABANDON', // Child survives parent continue-as-new
    });

    childrenStarted.push(childId);
    currentRecords[record.id] = true;

    log.info('Started child', { 
      recordId: record.id, 
      windowSize: Object.keys(currentRecords).length 
    });
  }

  // Update offset
  offset = input.offset + childrenStarted.length;

  // Continue-as-new or complete
  if (offset < input.maximumOffset) {
    log.info('Continuing as new', { offset, progress });
    
    await continueAsNew<typeof slidingWindowBatch>({
      pageSize: input.pageSize,
      slidingWindowSize: input.slidingWindowSize,
      offset,
      maximumOffset: input.maximumOffset,
      progress,
      currentRecords,
    });
  }

  // Wait for all remaining children
  await condition(() => Object.keys(currentRecords).length === 0);

  log.info('Batch completed', { totalProcessed: progress });
  return progress;
}

// ============================================================================
// Child Workflow - Record Processor
// ============================================================================

/**
 * Process a single record and signal completion to the parent.
 * 
 * Uses getExternalWorkflowHandle to signal the parent workflow directly,
 * which is more efficient than using an activity.
 */
export async function processRecord(record: RecordItem, parentWorkflowId: string): Promise<void> {
  const { doWork } = proxyActivities<typeof activities>({
    startToCloseTimeout: '5 minutes',
    heartbeatTimeout: '30 seconds',
  });

  log.info('Processing record', { recordId: record.id });

  try {
    // Do the actual work
    await doWork(record);
    
    log.info('Record processed successfully', { recordId: record.id });
  } finally {
    // Signal the parent that this record is complete
    // Use getExternalWorkflowHandle to get a handle to the parent
    const parentHandle = getExternalWorkflowHandle(parentWorkflowId);
    
    try {
      await parentHandle.signal(completionSignal, record.id);
      log.info('Signaled parent', { recordId: record.id, parentWorkflowId });
    } catch (err) {
      // Parent may have completed or continued-as-new
      // This is expected and not an error
      log.warn('Could not signal parent', { 
        recordId: record.id, 
        error: String(err) 
      });
    }
  }
}

// ============================================================================
// Alternative: Simpler Version Without Signals (Await Child Results)
// ============================================================================

/**
 * This is a simpler alternative that awaits child workflow results
 * instead of using signals. Trade-offs:
 * 
 * Pros:
 * - Simpler, no signal handling needed
 * - Child failures are automatically propagated
 * 
 * Cons:
 * - Can't use continue-as-new mid-batch (must complete all children first)
 * - Higher history growth as we track all futures
 */
export async function simpleSlidingWindowBatch(
  input: SlidingWindowInput
): Promise<number> {
  const { fetchRecords, doWork } = proxyActivities<typeof activities>({
    startToCloseTimeout: '5 minutes',
  });

  let offset = input.offset;
  let progress = input.progress;
  const pendingChildren: Array<{ id: number; promise: Promise<void> }> = [];

  // Fetch records
  const records = await fetchRecords(offset, input.pageSize, input.maximumOffset);

  for (const record of records) {
    // Wait for window capacity
    while (pendingChildren.length >= input.slidingWindowSize) {
      // Wait for at least one child to complete
      const completed = await Promise.race(pendingChildren.map(c => c.promise.then(() => c.id)));
      const idx = pendingChildren.findIndex(c => c.id === completed);
      pendingChildren.splice(idx, 1);
      progress++;
    }

    // Start new child
    const childPromise = doWork(record);
    pendingChildren.push({ id: record.id, promise: childPromise });
  }

  // Wait for all remaining children
  await Promise.all(pendingChildren.map(c => c.promise));
  progress += pendingChildren.length;

  offset += records.length;

  // Continue-as-new if more records
  if (offset < input.maximumOffset) {
    await continueAsNew<typeof simpleSlidingWindowBatch>({
      ...input,
      offset,
      progress,
      currentRecords: {},
    });
  }

  return progress;
}
