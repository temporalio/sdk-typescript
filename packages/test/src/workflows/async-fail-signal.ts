import { setListener, sleep } from '@temporalio/workflow';
import { failSignal } from './definitions';

export async function asyncFailSignalWorkflow(): Promise<void> {
  setListener(failSignal, async () => {
    await sleep(100);
    throw new Error('Signal failed');
  });
  // Don't complete to allow Workflow to be interrupted by fail() signal
  await sleep(100000);
}
