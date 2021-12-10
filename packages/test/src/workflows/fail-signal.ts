import { setHandler, sleep, ApplicationFailure } from '@temporalio/workflow';
import { failSignal } from './definitions';

export async function failSignalWorkflow(): Promise<void> {
  setHandler(failSignal, () => {
    throw ApplicationFailure.nonRetryable('Signal failed');
  });
  // Don't complete to allow Workflow to be interrupted by fail() signal
  await sleep(100000);
}
