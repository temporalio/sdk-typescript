import { setWorkflowOptions, workflowInfo, sleep, makeContinueAsNewFunc } from '@temporalio/workflow';
import { SuggestContinueAsNewReason } from '@temporalio/common';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithVersionUpgrade);
export async function continueAsNewWithVersionUpgrade(attempt: number): Promise<string> {
  console.log("IN WF1");
  if (attempt > 0) {
    console.log("ATTEMPT > 1");
    return 'v1.0';
  }

  while (true) {
    console.log("IN LOOP");
    await sleep(10); // 10ms - triggers WFT to refresh suggestion
    const info = workflowInfo();
    console.log("GOT WF INFO", info);
    if (info.continueAsNewSuggested) {
      console.log("CAN SUGGESTED");
      const reasons = info.suggestedContinueAsNewReasons ?? [];
      console.log("REASONS", reasons);
      if (reasons.includes(SuggestContinueAsNewReason.TARGET_WORKER_DEPLOYMENT_VERSION_CHANGED)) {
        console.log("VERSION CHANGED - THROWING CAN");
        const canWithInitialVersioningBehavior = makeContinueAsNewFunc<typeof continueAsNewWithVersionUpgrade>({
          initialVersioningBehavior: 'AUTO_UPGRADE',
        });
        await canWithInitialVersioningBehavior(attempt + 1);
      }
    }
  }
}