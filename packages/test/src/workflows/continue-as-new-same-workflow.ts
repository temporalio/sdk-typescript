/**
 * Tests continueAsNew for the same Workflow from main and signal handler
 * @module
 */
import { Context, CancellationScope } from '@temporalio/workflow';
import { ContinueAsNewFromMainAndSignal } from '../interfaces';

const signals = {
  async continueAsNew(): Promise<void> {
    await Context.continueAsNew<typeof main>('none');
  },
};

async function main(continueFrom: 'main' | 'signal' | 'none' = 'main'): Promise<void> {
  if (continueFrom === 'none') {
    return;
  }
  if (continueFrom === 'main') {
    await Context.continueAsNew<typeof main>('signal');
  }
  await CancellationScope.current().cancelRequested;
}

export const workflow: ContinueAsNewFromMainAndSignal = { main, signals };
