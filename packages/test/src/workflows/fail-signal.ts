import { sleep } from '@temporalio/workflow';
import { Failable } from '../interfaces';

const signals = {
  // Throw an error directly in the signal handler, this should be translated to a failWorkflowExecution command
  fail(): never {
    throw new Error('Signal failed');
  },
};

async function main(): Promise<void> {
  // Don't complete to allow Workflow to be interrupted by fail() signal
  await sleep(100000);
}

export const workflow: Failable = { main, signals };
