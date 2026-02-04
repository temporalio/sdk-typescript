import { setWorkflowOptions, workflowInfo, sleep, makeContinueAsNewFunc } from '@temporalio/workflow';
import { SuggestContinueAsNewReason } from '@temporalio/common';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithVersionUpgrade);
export async function continueAsNewWithVersionUpgrade(attempt: number): Promise<string> {
  if (attempt > 0) {
    return 'v1.0';
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(10); // 10ms - triggers WFT to refresh suggestion
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      const reasons = info.suggestedContinueAsNewReasons ?? [];
      if (reasons.includes(SuggestContinueAsNewReason.TARGET_WORKER_DEPLOYMENT_VERSION_CHANGED)) {
        const canWithInitialVersioningBehavior = makeContinueAsNewFunc<typeof continueAsNewWithVersionUpgrade>({
          initialVersioningBehavior: 'AUTO_UPGRADE',
        });
        await canWithInitialVersioningBehavior(attempt + 1);
      }
    }
  }
}
