/**
 * Tests continueAsNew for the same Workflow from execute and signal handler
 * @module
 */
import { Context, CancellationScope } from '@temporalio/workflow';
import { ContinueAsNewFromMainAndSignal } from '../interfaces';

const signals = {
  async continueAsNew(): Promise<void> {
    await Context.continueAsNew<typeof execute>('none');
  },
};

async function execute(continueFrom: 'execute' | 'signal' | 'none' = 'execute'): Promise<void> {
  if (continueFrom === 'none') {
    return;
  }
  if (continueFrom === 'execute') {
    await Context.continueAsNew<typeof execute>('signal');
  }
  await CancellationScope.current().cancelRequested;
}

export const workflow: ContinueAsNewFromMainAndSignal = { execute, signals };
