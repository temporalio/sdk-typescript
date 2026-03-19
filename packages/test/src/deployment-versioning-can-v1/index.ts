import { setWorkflowOptions, workflowInfo, sleep, makeContinueAsNewFunc } from '@temporalio/workflow';

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithVersionUpgrade);
export async function continueAsNewWithVersionUpgrade(attempt: number): Promise<string> {
  if (attempt > 0) {
    return 'v1.0';
  }

  while (true) {
    await sleep(10); // 10ms - triggers WFT to refresh the flag
    const info = workflowInfo();
    if (info.targetWorkerDeploymentVersionChanged) {
      const canWithAutoUpgrade = makeContinueAsNewFunc<typeof continueAsNewWithVersionUpgrade>({
        initialVersioningBehavior: 'AUTO_UPGRADE',
      });
      await canWithAutoUpgrade(attempt + 1);
    }
  }
}
