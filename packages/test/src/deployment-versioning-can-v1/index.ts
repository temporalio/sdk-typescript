import {
  condition,
  setHandler,
  setWorkflowOptions,
  workflowInfo,
  sleep,
  makeContinueAsNewFunc,
} from '@temporalio/workflow';
import { unblockSignal } from '../workflows';

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

setWorkflowOptions({ versioningBehavior: 'PINNED' }, continueAsNewWithRampingVersion);
export async function continueAsNewWithRampingVersion(attempt: number): Promise<string> {
  if (attempt > 0) {
    return 'v1.0';
  }

  let shouldContinue = false;
  setHandler(unblockSignal, () => void (shouldContinue = true));
  await condition(() => shouldContinue);

  const canWithRampingVersion = makeContinueAsNewFunc<typeof continueAsNewWithRampingVersion>({
    initialVersioningBehavior: 'USE_RAMPING_VERSION',
  });
  return await canWithRampingVersion(attempt + 1);
}
