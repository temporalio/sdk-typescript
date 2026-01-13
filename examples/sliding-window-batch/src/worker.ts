import { Worker } from '@temporalio/worker';
import * as activities from './activities';

/**
 * Worker that executes both the sliding window workflow and record processor workflows.
 */
async function main() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: 'sliding-window-batch',
  });

  console.log('Worker started, listening on task queue: sliding-window-batch');
  await worker.run();
}

main().catch((err) => {
  console.error('Worker error:', err);
  process.exit(1);
});
