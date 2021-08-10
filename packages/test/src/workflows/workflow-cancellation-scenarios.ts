import { CancellationScope, CancelledFailure, sleep } from '@temporalio/workflow';
import { WorkflowCancellationScenarios } from '../interfaces';

async function main(outcome: 'complete' | 'cancel' | 'fail', when: 'immediately' | 'after-cleanup'): Promise<void> {
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
}

export const workflow: WorkflowCancellationScenarios = { main };
