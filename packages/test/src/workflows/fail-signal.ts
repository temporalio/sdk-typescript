import { setListener, sleep } from '@temporalio/workflow';
import { failSignal } from './definitions';

export async function failSignalWorkflow(): Promise<void> {
  setListener(failSignal, () => {
    throw new Error('Signal failed');
  });
  // Don't complete to allow Workflow to be interrupted by fail() signal
  await sleep(100000);
}
