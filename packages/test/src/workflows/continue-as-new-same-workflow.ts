/**
 * Tests continueAsNew for the same Workflow from execute and signal handler
 * @module
 */
import { Context, CancellationScope } from '@temporalio/workflow';
import { ContinueAsNewFromMainAndSignal } from '../interfaces';

export const continueAsNewSameWorkflow: ContinueAsNewFromMainAndSignal = (
  continueFrom: 'execute' | 'signal' | 'none' = 'execute'
) => {
  return {
    async execute(): Promise<void> {
      if (continueFrom === 'none') {
        return;
      }
      if (continueFrom === 'execute') {
        await Context.continueAsNew<typeof continueAsNewSameWorkflow>('signal');
      }
      await CancellationScope.current().cancelRequested;
    },
    signals: {
      async continueAsNew(): Promise<void> {
        await Context.continueAsNew<typeof continueAsNewSameWorkflow>('none');
      },
    },
  };
};
