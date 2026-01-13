import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
  log,
} from '@temporalio/workflow';

// ============================================================================
// Types (defined here to avoid circular imports with activities)
// ============================================================================

export interface SlidingWindowWorkflowInput {
  pageSize: number;
  slidingWindowSize: number;
  offset: number; // inclusive
  maximumOffset: number; // exclusive
  progress: number;
  // The set of record IDs currently being processed
  currentRecords: Record<number, boolean>; // recordId -> ignored boolean (used as a Set)
}

export interface SlidingWindowState {
  currentRecords: number[];
  childrenStartedByThisRun: number;
  offset: number;
  progress: number;
}

export interface RecordData {
  id: number;
  data: string;
}

export interface GetRecordsInput {
  pageSize: number;
  offset: number;
  maxOffset: number;
}

export interface GetRecordsOutput {
  records: RecordData[];
}

// Activity interface - must match activities.ts exports
interface Activities {
  getRecords(input: GetRecordsInput): Promise<GetRecordsOutput>;
  processRecord(record: RecordData): Promise<void>;
  signalParentCompletion(recordId: number): Promise<void>;
}

// Activity proxy
const { getRecords } = proxyActivities<Activities>({
  startToCloseTimeout: '5 seconds',
});

// ============================================================================
// Signals and Queries
// ============================================================================

/**
 * Signal sent by child workflows when they complete processing a record
 */
export const reportCompletionSignal = defineSignal<[number]>('ReportCompletion');

/**
 * Query to get the current state of the batch processing
 */
export const stateQuery = defineQuery<SlidingWindowState>('state');

// ============================================================================
// Main Sliding Window Workflow
// ============================================================================

/**
 * SlidingWindowWorkflow processes a range of records using a sliding window
 * of concurrent child workflows.
 *
 * As soon as a child workflow completes (signaled via ReportCompletion),
 * a new one is started to maintain the sliding window size.
 *
 * Features:
 * - Uses continue-as-new to handle large batches without history bloat
 * - Child workflows use ABANDON parent close policy to survive continue-as-new
 * - Signal-based completion tracking for reliable progress updates
 */
export async function slidingWindowWorkflow(
  input: SlidingWindowWorkflowInput
): Promise<number> {
  log.info('SlidingWindowWorkflow started', {
    slidingWindowSize: input.slidingWindowSize,
    pageSize: input.pageSize,
    offset: input.offset,
    maximumOffset: input.maximumOffset,
    progress: input.progress,
  });

  // State
  const currentRecords: Record<number, boolean> = input.currentRecords ?? {};
  let offset = input.offset;
  let progress = input.progress;
  const childrenStartedByThisRun: string[] = [];

  // ============================================================================
  // Query Handler
  // ============================================================================

  setHandler(stateQuery, (): SlidingWindowState => {
    // Get sorted list of current record IDs
    const recordIds = Object.keys(currentRecords)
      .map(Number)
      .sort((a, b) => a - b);

    return {
      currentRecords: recordIds,
      childrenStartedByThisRun: childrenStartedByThisRun.length,
      offset,
      progress,
    };
  });

  // ============================================================================
  // Signal Handler for child workflow completion
  // ============================================================================

  setHandler(reportCompletionSignal, (recordId: number) => {
    // Duplicate signal check - only process if record is in current set
    if (currentRecords[recordId]) {
      delete currentRecords[recordId];
      progress += 1;
      log.info('Record completed', { recordId, progress });
    }
  });

  // ============================================================================
  // Main Processing Logic
  // ============================================================================

  // Fetch the next page of records if we haven't reached the end
  let records: RecordData[] = [];
  if (offset < input.maximumOffset) {
    const output = await getRecords({
      pageSize: input.pageSize,
      offset: offset,
      maxOffset: input.maximumOffset,
    });
    records = output.records;
  }

  const workflowId = workflowInfo().workflowId;

  // Process each record
  for (const record of records) {
    // Block until sliding window has capacity
    await condition(() => Object.keys(currentRecords).length < input.slidingWindowSize);

    // Start child workflow with ABANDON policy so it survives continue-as-new
    const childWorkflowId = `${workflowId}/${record.id}`;
    
    const childHandle = await startChild(recordProcessorWorkflow, {
      args: [record],
      workflowId: childWorkflowId,
      parentClosePolicy: 'ABANDON',
    });

    childrenStartedByThisRun.push(childWorkflowId);
    currentRecords[record.id] = true;

    log.info('Started child workflow', { 
      recordId: record.id, 
      childWorkflowId,
      currentWindowSize: Object.keys(currentRecords).length 
    });
  }

  // Update offset for the next batch
  offset = input.offset + childrenStartedByThisRun.length;

  // ============================================================================
  // Continue-as-new or Complete
  // ============================================================================

  if (offset < input.maximumOffset) {
    // More records to process - continue as new
    log.info('Continuing as new', { 
      newOffset: offset, 
      currentRecordsCount: Object.keys(currentRecords).length,
      progress 
    });

    // Note: In TypeScript, signal handlers are automatically drained before
    // continue-as-new, unlike Go where manual draining is required.
    
    await continueAsNew<typeof slidingWindowWorkflow>({
      pageSize: input.pageSize,
      slidingWindowSize: input.slidingWindowSize,
      offset: offset,
      maximumOffset: input.maximumOffset,
      progress: progress,
      currentRecords: currentRecords,
    });
  }

  // Last run - wait for all children to complete
  log.info('Waiting for all children to complete', { 
    remainingRecords: Object.keys(currentRecords).length 
  });

  await condition(() => Object.keys(currentRecords).length === 0);

  log.info('All records processed', { totalProgress: progress });
  return progress;
}

// ============================================================================
// Child Workflow - Record Processor
// ============================================================================

/**
 * RecordProcessorWorkflow processes a single record and signals completion
 * back to the parent workflow.
 */
export async function recordProcessorWorkflow(record: RecordData): Promise<void> {
  const { processRecord, signalParentCompletion } = proxyActivities<Activities>({
    startToCloseTimeout: '1 minute',
  });

  log.info('Processing record', { recordId: record.id });

  try {
    // Process the record (your business logic here)
    await processRecord(record);

    log.info('Record processing completed', { recordId: record.id });
  } finally {
    // Always signal completion, even if processing failed
    // This ensures the parent workflow's sliding window doesn't get stuck
    await signalParentCompletion(record.id);
  }
}
