import { Context } from '@temporalio/activity';
import { Client } from '@temporalio/client';

// Define types locally to avoid importing from workflows (workflow code can't be imported in activities)
export interface GetRecordsInput {
  pageSize: number;
  offset: number;
  maxOffset: number;
}

export interface RecordData {
  id: number;
  data: string;
}

export interface GetRecordsOutput {
  records: RecordData[];
}

// ============================================================================
// Record Loading Activity
// ============================================================================

/**
 * GetRecords fetches a page of records to process.
 * In a real implementation, this would query a database or external service.
 */
export async function getRecords(input: GetRecordsInput): Promise<GetRecordsOutput> {
  const { pageSize, offset, maxOffset } = input;
  
  // Simulate fetching records from a data source
  const records: RecordData[] = [];
  const end = Math.min(offset + pageSize, maxOffset);
  
  for (let i = offset; i < end; i++) {
    records.push({
      id: i,
      data: `Record data for item ${i}`,
    });
  }

  console.log(`Fetched ${records.length} records (offset: ${offset}, maxOffset: ${maxOffset})`);
  
  return { records };
}

// ============================================================================
// Record Processing Activity
// ============================================================================

/**
 * ProcessRecord performs the actual work on a single record.
 * Replace this with your actual business logic.
 */
export async function processRecord(record: RecordData): Promise<void> {
  const context = Context.current();
  
  console.log(`Processing record ${record.id}: ${record.data}`);
  
  // Simulate some work with heartbeating for long-running tasks
  const workDuration = 1000 + Math.random() * 2000; // 1-3 seconds
  const heartbeatInterval = 500;
  
  const startTime = Date.now();
  while (Date.now() - startTime < workDuration) {
    context.heartbeat(`Processing record ${record.id}`);
    await new Promise(resolve => setTimeout(resolve, heartbeatInterval));
  }
  
  console.log(`Completed processing record ${record.id}`);
}

// ============================================================================
// Signal Parent Activity
// ============================================================================

// Signal name constant - must match the signal name in workflows.ts
const REPORT_COMPLETION_SIGNAL = 'ReportCompletion';

/**
 * SignalParentCompletion sends a completion signal back to the parent workflow.
 * 
 * This activity extracts the parent workflow ID from the current workflow context
 * and signals the parent that the record has been processed.
 * 
 * Note: This approach uses an activity to signal the parent. For a cleaner
 * approach, see workflows-v2.ts which uses getExternalWorkflowHandle directly
 * from within the child workflow.
 */
export async function signalParentCompletion(recordId: number): Promise<void> {
  const context = Context.current();
  const workflowInfo = context.info;
  
  // Extract parent workflow ID from child workflow ID
  // Child workflow ID format: parentWorkflowId/recordId
  const currentWorkflowId = workflowInfo.workflowExecution.workflowId;
  const lastSlashIndex = currentWorkflowId.lastIndexOf('/');
  
  if (lastSlashIndex === -1) {
    throw new Error(`Invalid child workflow ID format: ${currentWorkflowId}`);
  }
  
  const parentWorkflowId = currentWorkflowId.substring(0, lastSlashIndex);
  
  // Create a client to signal the parent
  // In production, you'd want to reuse a client instance
  const client = new Client();
  
  try {
    const parentHandle = client.workflow.getHandle(parentWorkflowId);
    // Use signal by name since we can't import workflow code in activities
    await parentHandle.signal(REPORT_COMPLETION_SIGNAL, recordId);
    
    console.log(`Signaled parent ${parentWorkflowId} about completion of record ${recordId}`);
  } finally {
    await client.connection.close();
  }
}
