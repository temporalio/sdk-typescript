/**
 * Tests continueAsNew for the same Workflow from execute and signal handler
 * @module
 */
import { continueAsNew, CancellationScope, defineSignal, setHandler } from '@temporalio/workflow';

export const continueAsNewSignal = defineSignal('continueAsNew');

export async function continueAsNewSameWorkflow(
  continueFrom: 'execute' | 'signal' | 'none' = 'execute',
  continueTo: 'execute' | 'signal' | 'none' = 'signal'
): Promise<void> {
  setHandler(continueAsNewSignal, async () => {
    await continueAsNew<typeof continueAsNewSameWorkflow>('none');
  });
  if (continueFrom === 'none') {
    return;
  }
  if (continueFrom === 'execute') {
    await continueAsNew<typeof continueAsNewSameWorkflow>(continueTo);
  }
  await CancellationScope.current().cancelRequested;
}
