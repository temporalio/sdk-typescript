import { Context } from '@temporalio/activity';
import type { RecordItem } from './workflows-v2';

/**
 * Fetch records for processing.
 * Replace with actual database/API calls.
 */
export async function fetchRecords(
  offset: number,
  pageSize: number,
  maxOffset: number
): Promise<RecordItem[]> {
  const records: RecordItem[] = [];
  const end = Math.min(offset + pageSize, maxOffset);

  for (let i = offset; i < end; i++) {
    records.push({
      id: i,
      data: `Data for record ${i}`,
    });
  }

  console.log(`Fetched ${records.length} records starting at offset ${offset}`);
  return records;
}

/**
 * Process a single record.
 * Replace with your actual business logic.
 */
export async function doWork(record: RecordItem): Promise<void> {
  const context = Context.current();
  
  console.log(`Starting work on record ${record.id}`);
  
  // Simulate work with heartbeats
  const duration = 2000 + Math.random() * 3000; // 2-5 seconds
  const start = Date.now();
  
  while (Date.now() - start < duration) {
    context.heartbeat(`Processing record ${record.id}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`Completed work on record ${record.id}`);
}
