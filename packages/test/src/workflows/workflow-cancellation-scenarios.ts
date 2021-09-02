import { CancellationScope, CancelledFailure, sleep } from '@temporalio/workflow';
import { CancellationScenarioRunner } from '../interfaces';

export const workflowCancellationScenarios: CancellationScenarioRunner = (outcome, when) => ({
  async execute(): Promise<void> {
    try {
      await CancellationScope.current().cancelRequested;
    } catch (e) {
      if (!(e instanceof CancelledFailure)) {
        throw e;
      }
      if (when === 'after-cleanup') {
        await CancellationScope.nonCancellable(async () => sleep(1));
      }
      switch (outcome) {
        case 'cancel':
          throw e;
        case 'complete':
          return;
        case 'fail':
          throw new Error('Expected failure');
      }
    }
  },
});
