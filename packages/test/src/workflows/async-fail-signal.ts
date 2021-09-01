import { sleep } from '@temporalio/workflow';
import { AsyncFailable } from '../interfaces';

const signals = {
  // Throw an error directly in the signal handler, this should be translated to a failWorkflowExecution command
  async fail(): Promise<never> {
    await sleep(100);
    throw new Error('Signal failed');
  },
};

async function execute(): Promise<void> {
  // Don't complete to allow Workflow to be interrupted by fail() signal
  await sleep(100000);
}

export const workflow: AsyncFailable = { execute, signals };
