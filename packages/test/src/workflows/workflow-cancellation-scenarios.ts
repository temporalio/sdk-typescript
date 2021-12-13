import { ApplicationFailure, CancellationScope, CancelledFailure, sleep } from '@temporalio/workflow';

export type WorkflowCancellationScenarioOutcome = 'complete' | 'cancel' | 'fail';
export type WorkflowCancellationScenarioTiming = 'immediately' | 'after-cleanup';

export async function workflowCancellationScenarios(
  outcome: WorkflowCancellationScenarioOutcome,
  when: WorkflowCancellationScenarioTiming
): Promise<void> {
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
        throw ApplicationFailure.nonRetryable('Expected failure');
    }
  }
}
