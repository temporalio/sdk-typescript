import type { VersioningOverride } from '@temporalio/common';
import {
  condition,
  executeChild,
  setHandler,
  setWorkflowOptions,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import { unblockSignal, versionQuery } from '../workflows';

export interface ChildVersioningOptions {
  childWorkflowId: string;
  childBehavior: 'PINNED' | 'AUTO_UPGRADE';
  versioningOverride?: VersioningOverride;
  api: 'startChild' | 'executeChild';
}

setWorkflowOptions({ versioningBehavior: 'PINNED' }, childVersioningParent);
export async function childVersioningParent(options: ChildVersioningOptions): Promise<string | undefined> {
  setHandler(versionQuery, () => workflowInfo().currentDeploymentVersion?.buildId);
  const child = options.childBehavior === 'PINNED' ? pinnedChild : autoUpgradeChild;
  const childOptions = {
    workflowId: options.childWorkflowId,
    versioningOverride: options.versioningOverride,
  };
  if (options.api === 'executeChild') {
    return await executeChild(child, childOptions);
  }
  const handle = await startChild(child, childOptions);
  return await handle.result();
}

async function waitForFinish(): Promise<string | undefined> {
  let finish = false;
  setHandler(unblockSignal, () => void (finish = true));
  setHandler(versionQuery, () => workflowInfo().currentDeploymentVersion?.buildId);
  await condition(() => finish);
  return workflowInfo().currentDeploymentVersion?.buildId;
}

setWorkflowOptions({ versioningBehavior: 'PINNED' }, pinnedChild);
export async function pinnedChild(): Promise<string | undefined> {
  return await waitForFinish();
}

setWorkflowOptions({ versioningBehavior: 'AUTO_UPGRADE' }, autoUpgradeChild);
export async function autoUpgradeChild(): Promise<string | undefined> {
  return await waitForFinish();
}
