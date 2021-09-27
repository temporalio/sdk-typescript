/**
 * Tests continueAsNew for the same Workflow from execute and signal handler
 * @module
 */
import { continueAsNew, CancellationScope } from '@temporalio/workflow';
import { ContinueAsNewFromMainAndSignal } from '../interfaces';

export const continueAsNewSameWorkflow: ContinueAsNewFromMainAndSignal = (
  continueFrom = 'execute',
  continueTo = 'signal'
) => ({
  async execute(): Promise<void> {
    if (continueFrom === 'none') {
      return;
    }
    if (continueFrom === 'execute') {
      await continueAsNew<ContinueAsNewFromMainAndSignal>(continueTo);
    }
    await CancellationScope.current().cancelRequested;
  },
  signals: {
    async continueAsNew(): Promise<void> {
      await continueAsNew<ContinueAsNewFromMainAndSignal>('none');
    },
  },
});
