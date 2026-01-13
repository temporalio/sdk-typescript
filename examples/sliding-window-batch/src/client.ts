import { Client } from '@temporalio/client';
import { slidingWindowWorkflow, stateQuery, SlidingWindowWorkflowInput } from './workflows';

/**
 * Example client that starts a sliding window batch workflow
 * and monitors its progress.
 */
async function main() {
  const client = new Client();

  try {
    // Start the sliding window batch workflow
    const input: SlidingWindowWorkflowInput = {
      pageSize: 10,           // Process 10 records per continue-as-new
      slidingWindowSize: 5,   // Maximum 5 concurrent child workflows
      offset: 0,              // Start from record 0
      maximumOffset: 100,     // Process records 0-99
      progress: 0,            // Initial progress
      currentRecords: {},     // No records in flight initially
    };

    console.log('Starting sliding window batch workflow...');
    console.log(`  Total records: ${input.maximumOffset}`);
    console.log(`  Page size: ${input.pageSize}`);
    console.log(`  Sliding window size: ${input.slidingWindowSize}`);

    const handle = await client.workflow.start(slidingWindowWorkflow, {
      taskQueue: 'sliding-window-batch',
      workflowId: `sliding-window-batch-${Date.now()}`,
      args: [input],
    });

    console.log(`\nStarted workflow ${handle.workflowId}`);

    // Monitor progress with queries
    const pollInterval = 2000; // 2 seconds
    let lastProgress = 0;

    const progressPoller = setInterval(async () => {
      try {
        const state = await handle.query(stateQuery);
        if (state.progress !== lastProgress) {
          console.log(`Progress: ${state.progress}/${input.maximumOffset} (${Math.round(state.progress / input.maximumOffset * 100)}%)`);
          console.log(`  Current window: ${state.currentRecords.length} records`);
          console.log(`  Offset: ${state.offset}`);
          lastProgress = state.progress;
        }
      } catch (err) {
        // Workflow might have continued-as-new, ignore query errors
      }
    }, pollInterval);

    // Wait for completion
    const result = await handle.result();
    clearInterval(progressPoller);

    console.log(`\nWorkflow completed! Total records processed: ${result}`);
  } finally {
    await client.connection.close();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
